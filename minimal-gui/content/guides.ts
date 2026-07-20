/**
 * Settings · 指南（S4）
 * 每条 1–3 句，可扫读；related 可选链到 Settings 分区 id。
 */

export type GuideSectionId =
  | "overview"
  | "permissions"
  | "workspace"
  | "presets"
  | "mcp"
  | "guides";

export interface GuideCard {
  id: string;
  title: string;
  /** 1–3 short sentences */
  body: string[];
  /** Settings nav section to jump to */
  related?: GuideSectionId;
  /** Optional file / flag hints */
  refs?: string[];
}

export const SETTINGS_GUIDES: GuideCard[] = [
  {
    id: "chat-vs-settings",
    title: "聊天栏 vs Settings",
    body: [
      "模型 Profile / Model、Skills 加载仍在聊天下方，改完马上对当前会话生效。",
      "Settings 管「能不能用 shell/web、有哪些子 Agent、怎么配置」这类策略与说明。",
      "高频操作放聊天，低频策略放设置，避免一条 Composer 塞满控件。",
    ],
  },
  {
    id: "profile-model",
    title: "怎么换模型",
    body: [
      "在聊天栏选 Profile（API 配置名）和 Model；会写入当前 session 的 llm_override。",
      "切换会话后会带回该会话上次的 profile/model，与 TUI 一致。",
      "改 agent.json 里的 api_profiles 需要重启 web 进程后才会出现新 Profile。",
    ],
    refs: ["聊天栏 Profile / Model", "agent.json → api_profiles"],
  },
  {
    id: "shell",
    title: "怎么开 Shell",
    body: [
      "Shell 打开后，Agent 才能调用 run_shell（工作区内的命令行）。",
      "启动时加 --allow-shell，或在 Settings → 权限 热开（仅当前进程，运行中不可改）。",
      "开 shell 等于高权限：只在本机 / 内网受信环境使用。跨目录只读另有 JIT 弹窗，不在这里。",
    ],
    related: "permissions",
    refs: ["npm run web -- --allow-shell", "Settings → 权限"],
  },
  {
    id: "path-escape",
    title: "跨工作目录读取许可",
    body: [
      "Agent 要读当前 cwd / grant 之外的路径时，会弹出「允许一次 / 本会话 / 拒绝」。",
      "这是只读 JIT：写入仍受硬限制；Shell / Web 请继续用 Settings 开关。",
      "长期访问请到 Settings → 工作区 allow 路径；本会话允许后同类逃逸可少点确认。",
    ],
    related: "workspace",
    refs: ["聊天中 JIT 弹窗", "Settings → 工作区"],
  },
  {
    id: "workspace-cwd",
    title: "工作区 allow 与切换 cwd",
    body: [
      "allow 把路径加入本会话 grants（可读/可写、可选附带 shell/web）。",
      "切换 cwd 优先点 grants 里的「设为 cwd」；运行中不可改。",
      "顶栏显示当前 active_cwd；回到 primary 可一键还原主项目根。",
    ],
    related: "workspace",
    refs: ["Settings → 工作区", "GET /v1/workspace"],
  },
  {
    id: "web-cap",
    title: "怎么开 Web",
    body: [
      "Web 打开后才可 web_fetch / web_search 等出站访问。",
      "启动 --allow-web，或在 Settings → 权限 热切；与「选哪家模型」无关。",
      "子 Agent 预设若需要 web 而进程关了 web，调用会失败。",
    ],
    related: "permissions",
    refs: ["--allow-web", "Settings → 权限"],
  },
  {
    id: "spawn-preset",
    title: "子 Agent 预设是什么",
    body: [
      "预设是写好的角色（工具、回合、提示词），主 Agent 用工具拉起，而不是在聊天里手写整段 system。",
      "spawn_agent = 同步等待结果；spawn_background = 后台 job，完成后会通知主会话。",
      "列表见 Settings → 子 Agent；改 agents/*.md 或 spawn_presets 后一般需重启。",
    ],
    related: "presets",
    refs: ["agent.json → spawn_presets", "agents/*.md"],
  },
  {
    id: "add-preset",
    title: "怎么加一个预设",
    body: [
      "在 agents/ 下写 SKILL 风格的 md（description + 工具 frontmatter），再在 agent.json 的 spawn_presets 注册 name 与 prompt_file。",
      "未注册的 agents/*.md 会出现在「未注册」列表，不会出现在 spawn 参数里。",
      "注册后重启 web，到 Settings → 子 Agent 确认工具与 shell/web 角标。",
    ],
    related: "presets",
    refs: ["agents/", "agent.json → spawn_presets"],
  },
  {
    id: "workflow-arm",
    title: "怎么武装 Workflow",
    body: [
      "侧栏 Workflows 点名称即武装：下一条用户消息会作为 workflow 任务入口（先确认 checkpoint）。",
      "武装是一次性心智：跑完或 disarm 后回到普通对话；也可用 /workflow 相关命令。",
      "DAG / 多角色流程在 workflows/*.json，不在 Settings 里编辑。",
    ],
    refs: ["侧栏 Workflows", "workflows/"],
  },
  {
    id: "session-note",
    title: "会话备注与列表副标题",
    body: [
      "侧栏会话悬停 → note：给人看的短标签（最多约 80 字）。",
      "无备注时副标题优先显示上次任务的 current_work / pending，而不是生硬任务原句。",
      "+ new 建空会话；del 删除磁盘会话（运行中不可删）。",
    ],
    refs: ["侧栏 Sessions"],
  },
  {
    id: "no-auth",
    title: "开发时不要每次贴 Token",
    body: [
      "内网 dogfood 可用：npm run web -- --no-auth（或 MINIMAL_WEB_NO_AUTH=1）。",
      "Next 侧可设 NEXT_PUBLIC_MINIMAL_WEB_NO_AUTH=1，浏览器直开即可连 API。",
      "这是开发开关：公网绑定或不可信网络不要关鉴权。",
    ],
    refs: ["--no-auth", "MINIMAL_WEB_NO_AUTH"],
  },
  {
    id: "jobs-strip",
    title: "顶部黄条与 Jobs",
    body: [
      "多后台 job 时顶栏固定一行摘要（数量 + 名字），避免预览刷屏导致页面抖动。",
      "明细看左侧 Jobs 面板；同步 spawn 会显示 spawn: 预设名。",
      "黄条不进主聊天时间线，子任务过程与主会话隔离。",
    ],
    refs: ["侧栏 Jobs"],
  },
  {
    id: "attachments",
    title: "附件去哪了",
    body: [
      "聊天栏 + 添加附件：文件上传到 workspace/gui-inbox/<session>/。",
      "发送时任务文本会带上路径，Agent 可用 read_file 等工具读取。",
      "气泡上的芯片是给人看的；路径块在刷新后仍会从历史投影回来。",
    ],
    refs: ["workspace/gui-inbox/"],
  },
  {
    id: "mcp-setup",
    title: "怎么接 MCP",
    body: [
      "在 agent.json 写 mcp_servers（stdio / streamable-http / sse），可参考仓库里的 agent.mcp.example.json。",
      "远程机机鉴权可用 oauth.client_credentials（client_id_env / client_secret_env），或静态 headers Bearer。",
      "改配置后需重启 web；连接结果与工具列表见 Settings → MCP。",
    ],
    related: "mcp",
    refs: ["agent.json → mcp_servers", "agent.mcp.example.json", "Settings → MCP"],
  },
  {
    id: "history-cap",
    title: "为什么只显示一部分历史",
    body: [
      "长会话默认只渲染最近约 80 条合并后的消息，减轻 DOM 卡顿。",
      "需要时可点「显示全部」；磁盘上的完整 transcript 仍在。",
      "这是显示限制，不是服务端删了历史。",
    ],
  },
];
