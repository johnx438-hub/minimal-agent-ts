---
name: wormhole
description: File transfer via command line. Generates temporary download links and passcodes for sharing files (images, docs, etc.) with users. Ideal for bridging messaging platforms with file size limits (<5GB).
---

# wormhole

一个端到端加密传输文件功能

## When to use

当用户在手机上的聊天app与Agent聊天需要图片或其他文件时，使用此skill利用wormhole中转文件并贴上链接

## Instructions

> **Note**: This tool uses Puppeteer under the hood (~200MB). First run may take a few seconds to launch Chromium.

---

## ⚙️ Core Command

Upload a local file to Wormhole.app and get a secure link + passcode.

```bash
# Syntax: node <project_path>/index.js --quiet <file_path>
node ~/.local/share/wormhole-cli/index.js --quiet /path/to/your/file.png
```

*   **`--quiet`** (`-q`): (Recommended) Only prints the download URL, suppressing progress bars to keep context clean.
*   **`--verbose`** (`-v`): Prints each step of the upload process for debugging.

---

## 📤 Agent Workflow

When the user asks to send an image or file:

1.  **Locate Tool**: Find wormhole-cli on this system. Try these methods in order:
    ```bash
    # Method 1: Check if 'wormhole' command is available
    which wormhole || which wormhole-cli
    
    # Method 2: Search common locations
    find ~ -name "index.js" -path "*wormhole*" 2>/dev/null | head -5
    
    # Method 3: Check npm global bin directory
    ls $(npm root -g)/../bin/ 2>/dev/null | grep wormhole
    ```
    Store the path as `$WORMHOLE_PATH` for use in step 2.

2.  **Verify Path**: Ensure the target file exists at `<file_path>` and `$WORMHOLE_PATH/index.js` is executable.

3.  **Execute**: Run `node $WORMHOLE_PATH --quiet <file_path>`.

4.  **Parse Output**: Extract the `Download URL` from the output string (format: `https://wormhole.app/[random_id]#[passcode]`).

5.  **Reply to User**: "Here is your file! 🔗 [Link] (Passcode: xxx)"

---

## 📋 Example Output

```text
Download can be started before upload is finished.
Program will exit once upload is complete...

Download URL: https://wormhole.app/[random_id]#[passcode]
