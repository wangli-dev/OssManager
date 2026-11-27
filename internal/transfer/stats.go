package transfer

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rclone/rclone/fs"
)

// StatsSnapshot 是界面顶部展示的实时传输速度（字节/秒）与活动任务数。
type StatsSnapshot struct {
	UpSpeed   int64 `json:"upSpeed"`
	DownSpeed int64 `json:"downSpeed"`
	Active    int64 `json:"active"`
}

var (
	upBytes       atomic.Int64
	downBytes     atomic.Int64
	activeUploads atomic.Int64

	sampleMu       sync.Mutex
	lastSampleTime time.Time
	lastUpBytes    int64
	lastDownBytes  int64
	lastUpSpeed    int64
	lastDownSpeed  int64
)

// countingObject 包装远程对象，在读取时累计字节数，用于统计上传/下载速度。
// 只包装 Open，其他 fs.Object 方法由内嵌对象提供。
type countingObject struct {
	fs.Object
	counter *atomic.Int64
}

func (o countingObject) Open(ctx context.Context, options ...fs.OpenOption) (io.ReadCloser, error) {
	reader, err := o.Object.Open(ctx, options...)
	if err != nil {
		return nil, err
	}
	return &countingReadCloser{ReadCloser: reader, counter: o.counter}, nil
}

type countingReadCloser struct {
	io.ReadCloser
	counter *atomic.Int64
}

func (r *countingReadCloser) Read(p []byte) (int, error) {
	n, err := r.ReadCloser.Read(p)
	if n > 0 {
		r.counter.Add(int64(n))
	}
	return n, err
}

// Snapshot 按两次调用之间的字节增量计算速度；界面每秒调用一次。
func Snapshot() StatsSnapshot {
	now := time.Now()
	up := upBytes.Load()
	down := downBytes.Load()
	sampleMu.Lock()
	defer sampleMu.Unlock()
	if lastSampleTime.IsZero() {
		lastSampleTime, lastUpBytes, lastDownBytes = now, up, down
		return StatsSnapshot{Active: activeCount()}
	}
	elapsed := now.Sub(lastSampleTime).Seconds()
	if elapsed >= 0.4 {
		lastUpSpeed = int64(float64(up-lastUpBytes) / elapsed)
		lastDownSpeed = int64(float64(down-lastDownBytes) / elapsed)
		if lastUpSpeed < 0 {
			lastUpSpeed = 0
		}
		if lastDownSpeed < 0 {
			lastDownSpeed = 0
		}
		lastSampleTime, lastUpBytes, lastDownBytes = now, up, down
	}
	return StatsSnapshot{UpSpeed: lastUpSpeed, DownSpeed: lastDownSpeed, Active: activeCount()}
}

// activeCount 返回正在上传与下载的任务数。
func activeCount() int64 {
	return activeUploads.Load() + runningDownloads()
}

func runningDownloads() int64 {
	taskMu.Lock()
	defer taskMu.Unlock()
	var count int64
	for _, id := range taskOrder {
		if task, ok := taskMap[id]; ok && task.Status == "running" {
			count++
		}
	}
	return count
}
