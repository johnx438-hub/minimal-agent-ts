# web-ui-legacy（已降级）

早期随 `npm run web` 附带的**静态 HTML 壳**，问题多、**不再作为产品门面**。

- 默认静态目录已改为 `public/web-ui/`（仅 API 说明页）。
- 若需考古，可将 server 的 `uiDir` 指到本目录，或临时把本目录内容拷回 `web-ui`。
- 实验性浏览器 UI 见仓库根 `minimal-gui/`（Next · **WIP**，不随 npm 发布）。
