---
name: cli-web-search
description: 跨平台 CLI 搜索引擎（Google/Bing/Brave/DuckDuckGo 等 7 种后端）+ MCP 支持
homepage: https://github.com/scottgl9/cli-web-search
---

# cli-web-search

一个使用简单的搜索引擎

## When to use

当需要联网搜索时使用

## Instructions

## 🚀 快速命令速查

### 🔍 **基础搜索**
```bash
# 默认搜索（10条结果）
cli-web-search "AI news today"

# JSON格式输出（适合脚本处理）
cli-web-search -f json "latest rust crates" | jq '.results[0].url'

# Markdown格式（直接粘贴到笔记里）
cli-web-search -f markdown "how to learn rust"

# 限制结果数量
cli-web-search -n 3 "best LLM for coding"
```

### 🌐 **指定搜索引擎**
```bash
# Brave（高质量，隐私友好）
cli-web-search -p brave "rust async programming"

# DuckDuckGo（免费，无需API key）
cli-web-search -p ddg "weather forecast"

# Google CSE（需要配置 API Key + Search Engine ID）
cli-web-search -p google "machine learning tutorial"
```

### 📄 **抓取单页内容**（类似 webfetch 但更轻量）
```bash
# 抓取网页并转文本
cli-web-search fetch "https://example.com" --stdout

# 转 Markdown格式
cli-web-search fetch "https://docs.rs/tokio" -f markdown --stdout

# 保存到文件
cli-web-search fetch "https://github.com/scottgl9/cli-web-search" -o page.txt
