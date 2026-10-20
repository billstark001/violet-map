# Public target examples

Use the same S3 backend configuration for AWS S3, MinIO and R2. Change endpoint, region, bucket and explicit credential environment references; keep disjoint source/original/cache/public/control prefixes. R2 uses `https://<account-id>.r2.cloudflarestorage.com`, region `auto`, and an explicitly configured custom public domain. An AWS/CDN target likewise declares its public base URL independently. A MinIO fixture may use the bucket's anonymous `public/objects/` prefix, never content/blobs/control.

For R2, a custom domain is required to use Cloudflare's cache. Configure cache eligibility for the immutable `objects/` path, including extensionless MessagePack, and bypass publication heads. Avoid long negative caching: a cached 404 can outlive a newly created object. Apply GET/HEAD CORS for the actual viewer origins; changing bucket CORS does not rewrite already cached response headers. Publication verification tests the actual anonymous channel before head commit.

Official references checked during implementation: [R2 caching](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/), [R2 consistency and negative caches](https://developers.cloudflare.com/r2/reference/consistency/), [MinIO container setup](https://github.com/minio/minio/blob/master/docs/docker/README.md). No supplier configuration or uploads are performed by these examples.

The Cloudflare cache/CORS and AWS [conditional write](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) references were rechecked on 2026-10-21 (Asia/Tokyo). Capability errors remain explicit for S3-compatible services that reject conditional requests; no second driver/protocol is attempted.
