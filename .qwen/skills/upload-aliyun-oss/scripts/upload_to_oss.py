#!/usr/bin/env python3
"""
阿里云 OSS 文件上传工具
支持上传图片和视频文件，返回签名访问 URL
"""

import os
import sys
import uuid
from datetime import datetime
from pathlib import Path

# OSS 配置
OSS_ACCESS_KEY_ID = os.getenv("OSS_ACCESS_KEY_ID")
OSS_ACCESS_KEY_SECRET = os.getenv("OSS_ACCESS_KEY_SECRET")
OSS_ENDPOINT = "oss-cn-beijing.aliyuncs.com"
OSS_BUCKET = "oss-picture-cnd"

# 支持的文件类型
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"}
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv", ".wmv", ".m4v"}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


def validate_config():
    """验证 OSS 配置是否完整"""
    missing = []
    if not OSS_ACCESS_KEY_ID:
        missing.append("OSS_ACCESS_KEY_ID")
    if not OSS_ACCESS_KEY_SECRET:
        missing.append("OSS_ACCESS_KEY_SECRET")

    if missing:
        print(f"错误：缺少以下环境变量配置：{', '.join(missing)}", file=sys.stderr)
        print("请在 ~/.zshrc 或 shell 配置文件中设置这些环境变量。", file=sys.stderr)
        sys.exit(1)


def get_content_type(file_ext: str) -> str:
    """根据文件扩展名获取 Content-Type"""
    content_types = {
        # 图片
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".bmp": "image/bmp",
        ".ico": "image/x-icon",
        # 视频
        ".mp4": "video/mp4",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".flv": "video/x-flv",
        ".wmv": "video/x-ms-wmv",
        ".m4v": "video/x-m4v",
    }
    return content_types.get(file_ext.lower(), "application/octet-stream")


def upload_to_oss(file_path: str) -> str:
    """上传文件到 OSS，返回签名访问 URL"""
    import oss2
    
    # 验证文件
    path = Path(file_path)
    if not path.exists():
        print(f"错误：文件不存在：{file_path}", file=sys.stderr)
        sys.exit(1)
    
    file_ext = path.suffix.lower()
    if file_ext not in ALLOWED_EXTENSIONS:
        print(f"错误：不支持的文件类型：{file_ext}", file=sys.stderr)
        print(f"支持的类型：{', '.join(sorted(ALLOWED_EXTENSIONS))}", file=sys.stderr)
        sys.exit(1)
    
    # 创建 OSS Bucket
    auth = oss2.Auth(OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET)
    bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET)
    
    # 生成唯一文件名
    unique_name = f"{uuid.uuid4().hex}{file_ext}"
    date_prefix = datetime.now().strftime("%Y/%m/%d")
    oss_key = f"uploads/{date_prefix}/{unique_name}"
    
    # 上传文件
    content_type = get_content_type(file_ext)
    with open(path, "rb") as f:
        bucket.put_object(oss_key, f.read(), headers={"Content-Type": content_type})

    # 生成签名 URL（默认有效期 365 天）
    expires = int(os.getenv("OSS_URL_EXPIRE_DAYS", "365")) * 24 * 3600
    url = bucket.sign_url("GET", oss_key, expires)
    # 确保 URL 使用 https
    if url.startswith("http://"):
        url = "https://" + url[7:]
    return url


def main():
    if len(sys.argv) < 2:
        print("用法：python upload_to_oss.py <文件路径>", file=sys.stderr)
        print("示例：python upload_to_oss.py /Users/cris/Desktop/image.png", file=sys.stderr)
        sys.exit(1)
    
    file_path = sys.argv[1]
    validate_config()
    
    url = upload_to_oss(file_path)
    print(url)


if __name__ == "__main__":
    main()