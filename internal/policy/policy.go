package policy

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"OssManager/internal/config"
)

// Get 读取桶策略原文；策略不存在时返回空字符串。
func Get(ctx context.Context, confPath, remote, bucket string) (string, error) {
	client := clientFor(confPath, remote)
	out, err := client.GetBucketPolicy(ctx, &s3.GetBucketPolicyInput{Bucket: aws.String(bucket)})
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "nosuchbucketpolicy") {
			return "", nil
		}
		return "", err
	}
	if out.Policy == nil {
		return "", nil
	}
	return *out.Policy, nil
}

// Put 写入桶策略原文。
func Put(ctx context.Context, confPath, remote, bucket, policyText string) error {
	client := clientFor(confPath, remote)
	_, err := client.PutBucketPolicy(ctx, &s3.PutBucketPolicyInput{
		Bucket: aws.String(bucket),
		Policy: aws.String(policyText),
	})
	return err
}

// Grant 是 ACL 中一条授权，供界面只读展示。
type Grant struct {
	Grantee    string `json:"grantee"`
	Type       string `json:"type"`
	Permission string `json:"permission"`
}

// ACL 是桶 ACL 的只读摘要。
type ACL struct {
	Owner  string  `json:"owner"`
	Grants []Grant `json:"grants"`
}

// GetACL 读取桶 ACL 摘要。
func GetACL(ctx context.Context, confPath, remote, bucket string) (ACL, error) {
	client := clientFor(confPath, remote)
	out, err := client.GetBucketAcl(ctx, &s3.GetBucketAclInput{Bucket: aws.String(bucket)})
	if err != nil {
		return ACL{}, err
	}
	result := ACL{}
	if out.Owner != nil {
		result.Owner = aws.ToString(out.Owner.ID)
	}
	for _, grant := range out.Grants {
		item := Grant{Grantee: "", Type: string(grant.Grantee.Type), Permission: string(grant.Permission)}
		if grant.Grantee.ID != nil {
			item.Grantee = *grant.Grantee.ID
		} else if grant.Grantee.URI != nil {
			item.Grantee = *grant.Grantee.URI
		}
		result.Grants = append(result.Grants, item)
	}
	return result, nil
}

// SetCannedACL 设置桶的 canned ACL，仅允许 private（私有）与 public-read（公共只读）两档；
// 更细粒度的授权请使用桶策略（PutPolicy）。
func SetCannedACL(ctx context.Context, confPath, remote, bucket, acl string) error {
	if acl != string(types.BucketCannedACLPrivate) && acl != string(types.BucketCannedACLPublicRead) {
		return fmt.Errorf("不支持的 ACL：%s（自定义授权请使用桶策略）", acl)
	}
	client := clientFor(confPath, remote)
	_, err := client.PutBucketAcl(ctx, &s3.PutBucketAclInput{
		Bucket: aws.String(bucket),
		ACL:    types.BucketCannedACL(acl),
	})
	return err
}

// CreateBucket 新建桶。
func CreateBucket(ctx context.Context, confPath, remote, bucket string) error {
	client := clientFor(confPath, remote)
	_, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)})
	return err
}

// SetExpiry 通过复制对象自身设置 Expires 头，实现对象过期提示。
func SetExpiry(ctx context.Context, confPath, remote, bucket, key string, days int) error {
	client := clientFor(confPath, remote)
	source := url.PathEscape(bucket + "/" + key)
	expires := time.Now().AddDate(0, 0, days)
	_, err := client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:            aws.String(bucket),
		Key:               aws.String(key),
		CopySource:        aws.String(source),
		MetadataDirective: types.MetadataDirectiveReplace,
		Expires:           aws.Time(expires),
	})
	return err
}

// Presign 生成预签名 GET 链接。
func Presign(ctx context.Context, confPath, remote, bucket, key string, expiry time.Duration) (string, error) {
	client := clientFor(confPath, remote)
	presigner := s3.NewPresignClient(client)
	out, err := presigner.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(expiry))
	if err != nil {
		return "", err
	}
	return out.URL, nil
}

func clientFor(confPath, remote string) *s3.Client {
	opts := config.RemoteOptions(confPath, remote)
	region := opts["region"]
	if region == "" {
		region = "us-east-1"
	}
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(opts["access_key_id"], opts["secret_access_key"], ""),
	}
	return s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint := opts["endpoint"]; endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
		o.UsePathStyle = true
	})
}
