package transfer

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rclone/rclone/fs"
	"OssManager/internal/rclonefs"
)

// Task 是一个下载任务的实时状态，供界面展示进度与速度。
type Task struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Local   string `json:"localPath"`
	Total   int64  `json:"total"`
	Done    int64  `json:"done"`
	Speed   int64  `json:"speed"`
	Status  string `json:"status"`
	Error   string `json:"error"`
	Started string `json:"started"`
	Elapsed int64  `json:"elapsedMs"`
}

const maxFinishedTasks = 60

var (
	taskMu    sync.Mutex
	taskMap   = map[string]*Task{}
	taskOrder []string
	taskSeq   int64
)

// NewTask 登记一个新下载任务。
func NewTask(remotePath, localPath string) *Task {
	name := remotePath
	if index := strings.LastIndex(remotePath, "/"); index >= 0 {
		name = remotePath[index+1:]
	}
	taskMu.Lock()
	defer taskMu.Unlock()
	taskSeq++
	task := &Task{
		ID:      fmt.Sprintf("task-%d", taskSeq),
		Name:    name,
		Path:    remotePath,
		Local:   localPath,
		Status:  "running",
		Started: time.Now().Format("2006-01-02 15:04:05"),
	}
	taskMap[task.ID] = task
	taskOrder = append([]string{task.ID}, taskOrder...)
	// 只保留最近的已完成任务，避免列表无限增长。
	if len(taskOrder) > maxFinishedTasks {
		for _, id := range taskOrder[maxFinishedTasks:] {
			if value, ok := taskMap[id]; ok && value.Status != "running" {
				delete(taskMap, id)
			}
		}
		if len(taskOrder) > maxFinishedTasks*2 {
			taskOrder = taskOrder[:maxFinishedTasks*2]
		}
	}
	return task
}

// SetTotal 记录对象总大小。
func (t *Task) SetTotal(size int64) {
	taskMu.Lock()
	t.Total = size
	taskMu.Unlock()
}

// AddBytes 累加已传输字节并返回累计值。
func (t *Task) AddBytes(count int64) int64 {
	taskMu.Lock()
	defer taskMu.Unlock()
	t.Done += count
	return t.Done
}

// SetSpeed 更新瞬时速度（字节/秒）。
func (t *Task) SetSpeed(speed float64) {
	taskMu.Lock()
	t.Speed = int64(speed)
	taskMu.Unlock()
}

// DoneBytes 读取已传输字节（线程安全）。
func (t *Task) DoneBytes() int64 {
	taskMu.Lock()
	defer taskMu.Unlock()
	return t.Done
}

// Restart 把任务恢复到刚开始的状态，用于分片失败后改走单流重试。
func (t *Task) Restart() {
	taskMu.Lock()
	defer taskMu.Unlock()
	t.Done = 0
	t.Speed = 0
	t.Status = "running"
	t.Error = ""
}

// Finish 标记任务完成或失败。
func (t *Task) Finish(err error) {
	taskMu.Lock()
	defer taskMu.Unlock()
	if err != nil {
		t.Status = "error"
		t.Error = err.Error()
	} else {
		t.Status = "done"
		if t.Total > 0 {
			t.Done = t.Total
		}
	}
	t.Speed = 0
	if started, parseErr := time.ParseInLocation("2006-01-02 15:04:05", t.Started, time.Local); parseErr == nil {
		t.Elapsed = time.Since(started).Milliseconds()
	}
}

// ListTasks 返回全部下载任务的快照，最新的在前。
func ListTasks() []Task {
	taskMu.Lock()
	defer taskMu.Unlock()
	result := make([]Task, 0, len(taskOrder))
	for _, id := range taskOrder {
		task, ok := taskMap[id]
		if !ok {
			continue
		}
		snapshot := *task
		if snapshot.Status == "running" {
			if started, err := time.ParseInLocation("2006-01-02 15:04:05", snapshot.Started, time.Local); err == nil {
				snapshot.Elapsed = time.Since(started).Milliseconds()
			}
		}
		result = append(result, snapshot)
	}
	return result
}

// ClearFinishedTasks 清除已完成与失败的任务，保留正在运行的。
func ClearFinishedTasks() {
	taskMu.Lock()
	defer taskMu.Unlock()
	var kept []string
	for _, id := range taskOrder {
		if task, ok := taskMap[id]; ok && task.Status == "running" {
			kept = append(kept, id)
			continue
		}
		delete(taskMap, id)
	}
	taskOrder = kept
}

// multiThreadCutoff 小于该大小的文件不分片：小文件多开连接反而更慢。
const multiThreadCutoff = 8 << 20

// DownloadWithProgress 下载单个对象并实时登记进度，速度按 400 毫秒窗口计算。
// streams 大于 1 且文件足够大时按字节区间并行下载，以更充分地利用带宽。
func DownloadWithProgress(ctx context.Context, confPath, remotePath, localDir string, streams int) (string, error) {
	if err := ensureConfig(confPath); err != nil {
		return "", err
	}
	parent, name := splitRemote(remotePath)
	if name == "" {
		return "", os.ErrInvalid
	}
	srcFs, err := rclonefs.NewFs(ctx, confPath, parent)
	if err != nil {
		return "", err
	}
	srcObj, err := srcFs.NewObject(ctx, name)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(localDir, name)
	size := srcObj.Size()
	task := NewTask(remotePath, target)
	task.SetTotal(size)

	if streams > 1 && size >= multiThreadCutoff {
		if err := downloadParallel(ctx, srcObj, target, size, streams, task); err == nil {
			if modTime := srcObj.ModTime(ctx); !modTime.IsZero() {
				_ = os.Chtimes(target, modTime, modTime)
			}
			task.Finish(nil)
			return target, nil
		}
		// 分片失败（例如服务端不支持范围请求）时删除半成品，退回单流重试。
		_ = os.Remove(target)
		task.Restart()
	}

	reader, err := srcObj.Open(ctx)
	if err != nil {
		task.Finish(err)
		return "", err
	}
	defer reader.Close()

	writer, err := os.Create(target)
	if err != nil {
		task.Finish(err)
		return "", err
	}

	buffer := make([]byte, 1<<20)
	var lastBytes int64
	lastTime := time.Now()
	for {
		count, readErr := reader.Read(buffer)
		if count > 0 {
			if _, writeErr := writer.Write(buffer[:count]); writeErr != nil {
				writer.Close()
				task.Finish(writeErr)
				return "", writeErr
			}
			done := task.AddBytes(int64(count))
			if now := time.Now(); now.Sub(lastTime) >= 400*time.Millisecond {
				task.SetSpeed(float64(done-lastBytes) / now.Sub(lastTime).Seconds())
				lastBytes, lastTime = done, now
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			writer.Close()
			task.Finish(readErr)
			return "", readErr
		}
	}
	if err := writer.Close(); err != nil {
		task.Finish(err)
		return "", err
	}
	if modTime := srcObj.ModTime(ctx); !modTime.IsZero() {
		_ = os.Chtimes(target, modTime, modTime)
	}
	task.Finish(nil)
	return target, nil
}

// downloadParallel 把对象按字节区间切给多个 goroutine 并行写入同一文件。
func downloadParallel(ctx context.Context, src fs.Object, target string, size int64, streams int, task *Task) error {
	if streams > int(size) {
		streams = int(size)
	}
	if streams < 1 {
		return os.ErrInvalid
	}
	file, err := os.Create(target)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Truncate(size); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	chunk := (size + int64(streams) - 1) / int64(streams)
	errCh := make(chan error, streams)
	var wg sync.WaitGroup
	for index := 0; index < streams; index++ {
		start := int64(index) * chunk
		if start >= size {
			break
		}
		end := start + chunk - 1
		if end >= size {
			end = size - 1
		}
		wg.Add(1)
		go func(start, end int64) {
			defer wg.Done()
			if err := downloadRange(ctx, src, file, start, end, task); err != nil {
				select {
				case errCh <- err:
				default:
				}
				cancel()
			}
		}(start, end)
	}

	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		lastDone, lastTime := int64(0), time.Now()
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				done := task.DoneBytes()
				task.SetSpeed(float64(done-lastDone) / now.Sub(lastTime).Seconds())
				lastDone, lastTime = done, now
			}
		}
	}()
	wg.Wait()
	close(stop)
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

// downloadRange 读取 [start, end] 区间并写入本地文件的对应偏移。
func downloadRange(ctx context.Context, src fs.Object, file *os.File, start, end int64, task *Task) error {
	reader, err := src.Open(ctx, &fs.RangeOption{Start: start, End: end})
	if err != nil {
		return err
	}
	defer reader.Close()
	want := end - start + 1
	buffer := make([]byte, 1<<20)
	var offset int64
	for offset < want {
		limit := int64(len(buffer))
		if remaining := want - offset; remaining < limit {
			limit = remaining
		}
		count, readErr := reader.Read(buffer[:limit])
		if count > 0 {
			if _, writeErr := file.WriteAt(buffer[:count], start+offset); writeErr != nil {
				return writeErr
			}
			offset += int64(count)
			task.AddBytes(int64(count))
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if offset != want {
		return io.ErrUnexpectedEOF
	}
	return nil
}
