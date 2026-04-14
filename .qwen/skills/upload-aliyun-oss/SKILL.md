---
name: upload-aliyun-oss
description: 上传图片或视频到阿里云 OSS 并返回签名访问链接。当用户需要上传本地图片/视频文件到云端获取 URL 时使用此 Skill。
---

# 阿里云 OSS 上传工具

将图片或视频上传到阿里云 OSS，返回签名访问链接。

## 使用方法

首先确认 Python 版本：

```bash
python3 --version   # 优先尝试
```

如果 `python3` 不存在，尝试：

```bash
python --version
```

如果系统未安装 Python，建议先安装：

- **macOS**: `brew install python3`
- **Ubuntu/Debian**: `sudo apt install python3`
- **Windows**: 从 [python.org](https://www.python.org/downloads/) 下载安装

执行上传脚本：

```bash
# 使用 python3（推荐）
python3 scripts/upload_to_oss.py <文件路径>

# 或使用 python
python scripts/upload_to_oss.py <文件路径>
```

示例：

```bash
python3 scripts/upload_to_oss.py /Users/cris/Desktop/image.png
```

## 使用前准备

### 1. 安装依赖

```bash
# 使用 pip3（推荐）
pip3 install -r scripts/requirements.txt

# 或使用 pip
pip install -r scripts/requirements.txt
```

### 2. 配置环境变量

必需环境变量：

- `OSS_ACCESS_KEY_ID`：阿里云 AccessKey ID
- `OSS_ACCESS_KEY_SECRET`：阿里云 AccessKey Secret

可选环境变量：

- `OSS_URL_EXPIRE_DAYS`：签名 URL 有效期（天数，默认 365 天）

**macOS / Linux (Zsh)：**

```bash
echo 'export OSS_ACCESS_KEY_ID=你的AccessKeyID' >> ~/.zshrc
echo 'export OSS_ACCESS_KEY_SECRET=你的AccessKeySecret' >> ~/.zshrc
source ~/.zshrc
```

**Windows：**
通过系统设置 → 环境变量，添加上述用户变量。

## 支持的文件类型

- **图片**：jpg, jpeg, png, gif, webp, svg, bmp, ico
- **视频**：mp4, avi, mov, mkv, webm, flv, wmv, m4v

## 功能特点

- 自动生成唯一文件名，避免覆盖
- 返回 HTTPS 签名访问 URL
- 默认有效期 365 天（可通过环境变量调整）
- 文件按日期归档存储

## 注意事项

- 返回的是**签名 URL**，非永久公开链接，有效期默认 365 天
- 大文件上传（>100MB）可能较慢，当前不支持分片上传
- Bucket 和 Endpoint 已内置固定配置
