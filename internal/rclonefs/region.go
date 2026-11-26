package rclonefs

// 阿里云 OSS 的 bucket 可能位于其他地域：用当前连接的地域端点访问会返回
// PermanentRedirect（403）。这里在首次访问某个 bucket 时读取响应头
// X-Amz-Bucket-Region，并改用对应地域的端点重新打开，避免「某些 bucket 打不开」。

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/rclone/rclone/fs"

	ossconfig "OssManager/internal/config"
)

const regionUnknown = "-"

var (
	regionMu      sync.Mutex
	bucketRegions = map[string]string{}
)

// NewFs 打开远程路径；阿里云 OSS 桶位于其他地域时自动切换到对应地域端点。
func NewFs(ctx context.Context, confPath, remotePath string) (fs.Fs, error) {
	remoteName, rest := splitRemotePath(remotePath)
	bucket := bucketNameOf(rest)
	if remoteName != "" && bucket != "" {
		opts := ossconfig.RemoteOptions(confPath, remoteName)
		if isAlibaba(opts) && validEndpoint(opts["endpoint"]) {
			region, known := cachedBucketRegion(remoteName, bucket)
			if !known {
				region = detectBucketRegion(ctx, confPath, remoteName, bucket)
				storeBucketRegion(remoteName, bucket, region)
			}
			if region != "" && region != regionUnknown && region != currentEndpointRegion(opts["endpoint"]) {
				if override := regionOverride(remoteName, opts, region, rest); override != "" {
					if remoteFs, err := fs.NewFs(ctx, override); err == nil {
						return remoteFs, nil
					}
				}
			}
		}
	}
	return fs.NewFs(ctx, remotePath)
}

// RemoteName 返回 remotePath 的连接名部分（冒号前）。
func RemoteName(remotePath string) string {
	name, _ := splitRemotePath(remotePath)
	return name
}

// BucketListRoot 判断目标是否是 S3 的「桶列表根」：只写连接名、路径为空，
// 且连接类型是 s3（配置里也没有内置桶名）。S3 的根是桶列表，不能直接放对象，
// 直接上传会报 Key must not be empty 这类隐晦错误，应提前拦住。
func BucketListRoot(confPath, remotePath string) bool {
	name, rest := splitRemotePath(remotePath)
	if name == "" || strings.Trim(rest, "/") != "" {
		return false
	}
	opts := ossconfig.RemoteOptions(confPath, name)
	return strings.EqualFold(strings.TrimSpace(opts["type"]), "s3") && strings.TrimSpace(opts["bucket"]) == ""
}

// splitRemotePath 拆出 "remote:path" 的远程名与路径。
func splitRemotePath(remotePath string) (string, string) {
	index := strings.Index(remotePath, ":")
	if index < 0 {
		return "", remotePath
	}
	return remotePath[:index], remotePath[index+1:]
}

// bucketNameOf 取路径的第一段作为 bucket 名；根路径返回空。
func bucketNameOf(rest string) string {
	rest = strings.TrimPrefix(rest, "/")
	if index := strings.Index(rest, "/"); index >= 0 {
		return rest[:index]
	}
	return rest
}

func isAlibaba(opts map[string]string) bool {
	return strings.EqualFold(opts["provider"], "Alibaba") || strings.EqualFold(opts["type"], "alibaba")
}

func bucketRegionKey(remoteName, bucket string) string {
	return remoteName + "|" + bucket
}

func cachedBucketRegion(remoteName, bucket string) (string, bool) {
	regionMu.Lock()
	defer regionMu.Unlock()
	value, ok := bucketRegions[bucketRegionKey(remoteName, bucket)]
	return value, ok
}

func storeBucketRegion(remoteName, bucket, region string) {
	if region == "" {
		region = regionUnknown
	}
	regionMu.Lock()
	defer regionMu.Unlock()
	bucketRegions[bucketRegionKey(remoteName, bucket)] = region
}

// regionRecorder 记录响应头里的 bucket 地域。
type regionRecorder struct {
	mu     sync.Mutex
	region string
}

func (r *regionRecorder) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(request)
	if response != nil {
		if value := response.Header.Get("X-Amz-Bucket-Region"); value != "" {
			r.mu.Lock()
			r.region = value
			r.mu.Unlock()
		}
	}
	return response, err
}

func (r *regionRecorder) Region() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.region
}

// detectBucketRegion 通过一次带签名的列桶请求读取 bucket 所在地域。
func detectBucketRegion(ctx context.Context, confPath, remoteName, bucket string) string {
	opts := ossconfig.RemoteOptions(confPath, remoteName)
	region := strings.TrimSpace(opts["region"])
	if region == "" {
		region = "cn-shanghai"
	}
	recorder := &regionRecorder{}
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(opts["access_key_id"], opts["secret_access_key"], ""),
		HTTPClient:  &http.Client{Transport: recorder, Timeout: 15 * time.Second},
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(opts["endpoint"])
		// 阿里云 OSS 不支持路径风格访问，必须使用 bucket.oss-xxx.aliyuncs.com。
		options.UsePathStyle = false
	})
	_, _ = client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:  aws.String(bucket),
		MaxKeys: aws.Int32(1),
	})
	return recorder.Region()
}

// currentEndpointRegion 从 oss-cn-shanghai.aliyuncs.com 这类端点取出当前地域。
func currentEndpointRegion(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return ""
	}
	host := parsed.Host
	if index := strings.Index(host, "."); index > 0 {
		host = host[:index]
	}
	return host
}

// regionOverride 用 bucket 实际地域的端点构造连接字符串。
func regionOverride(remoteName string, opts map[string]string, region, rest string) string {
	if !strings.HasPrefix(region, "oss-") {
		return ""
	}
	endpoint := "https://" + region + ".aliyuncs.com"
	quote := func(value string) string {
		return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	parts := []string{
		"s3",
		"provider=" + quote("Alibaba"),
		"env_auth=" + quote("false"),
		"endpoint=" + quote(endpoint),
		"region=" + quote(region),
	}
	if value := opts["access_key_id"]; value != "" {
		parts = append(parts, "access_key_id="+quote(value))
	}
	if value := opts["secret_access_key"]; value != "" {
		parts = append(parts, "secret_access_key="+quote(value))
	}
	if value := opts["v2_auth"]; value != "" {
		parts = append(parts, "v2_auth="+quote(value))
	}
	if rest == "" {
		return ""
	}
	return ":" + strings.Join(parts, ",") + ":" + rest
}

// validEndpoint 只对阿里云官方端点做地域改写，自定义端点保持原样。
func validEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	return err == nil && parsed.Host != "" && strings.HasSuffix(parsed.Host, ".aliyuncs.com")
}
