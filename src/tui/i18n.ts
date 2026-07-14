/**
 * Lightweight TUI locale (zh | en). Command tokens stay English (/sessions).
 */

export type TuiLocale = 'zh' | 'en';

export function normalizeLocale(value: unknown): TuiLocale {
  if (value === 'en' || value === 'english') return 'en';
  if (value === 'zh' || value === 'cn' || value === 'zh-cn' || value === 'chinese') {
    return 'zh';
  }
  return 'zh';
}

/** Overlay / chrome copy for main interactive paths. */
const UI = {
  zh: {
    hintFooter: 'Enter 发送 · Esc 关面板/确认停止 · / 命令',
    sessionsTitle:
      '会话 — Enter 恢复 · i 详情 · n 备注 · d 删除 · Esc 取消',
    sessionsSubtitle: '左: 时间·备注|短id   右: 最近任务摘要 · 文件 · Nt',
    sessionsDeleteTitle: '永久删除',
    sessionsDeleteDesc: '会话 + actions + spawn + jobs',
    sessionsCancelTitle: '取消',
    sessionsCancelDesc: '保留会话 (Esc)',
    noteTitle: (id: string) => `备注 · ${id}`,
    noteHint: (max: number) =>
      `Enter 保存 · Esc 取消 · 空内容清除 · 最多 ${max} 字`,
    sessionDetailKeys: 'Enter 恢复 · h 历史 · n 备注 · Esc 返回',
    stopTitle: '停止当前运行？\n  后台 jobs 会继续，除非单独取消。',
    stopConfirm: '停止运行',
    stopConfirmDesc: '中止主 Agent（会话会保存）',
    stopKeep: '继续运行',
    stopKeepDesc: '关闭并继续 (Esc)',
    firstRunTitle: (shell: string, web: string) =>
      `首次运行 — 确认工具\n  shell [${shell}]  web [${web}]`,
    firstRunContinue: '继续',
    firstRunContinueDesc: '保存并开始',
    firstRunToggleShell: '切换 shell',
    firstRunToggleWeb: '切换 web',
    currently: (on: boolean) => (on ? '当前 on' : '当前 off'),
    skillsTitle: 'Skills — Enter 加载 · Esc 取消',
    profilesTitle: 'API profiles — Enter 选择 · Esc 取消',
    modelsTitle: 'Models — Enter 选择 · Esc 取消',
    reasoningTitle: 'Reasoning — Enter 选择 · Esc 取消',
    workflowsTitle: 'Workflows — Enter 武装 · Esc 取消',
    jobsTitle: 'Jobs — Enter 状态 · t 日志 · Esc 取消',
    spawnsTitle: 'Spawn presets — Enter 详情 · Esc 取消',
    langSet: (loc: string) => `界面语言: ${loc === 'en' ? 'English' : '中文'}`,
    langUsage: '用法: /lang zh|en',
    langStatus: (loc: string) =>
      `当前语言: ${loc === 'en' ? 'en (English)' : 'zh (中文)'} — /lang zh|en`,
  },
  en: {
    hintFooter: 'Enter send · Esc closes panels / confirms stop · / for commands',
    sessionsTitle:
      'Sessions — Enter resume · i detail · n note · d delete · Esc cancel',
    sessionsSubtitle: 'Left: time · note|id   Right: last task summary · files · Nt',
    sessionsDeleteTitle: 'Delete permanently',
    sessionsDeleteDesc: 'Session + actions + spawn + jobs',
    sessionsCancelTitle: 'Cancel',
    sessionsCancelDesc: 'Keep session (Esc)',
    noteTitle: (id: string) => `Note for ${id}`,
    noteHint: (max: number) =>
      `Enter save · Esc cancel · empty clears · max ${max} chars`,
    sessionDetailKeys: 'Enter resume · h history · n note · Esc back',
    stopTitle:
      'Stop current run?\n  Background jobs keep running unless you cancel them separately.',
    stopConfirm: 'Stop run',
    stopConfirmDesc: 'Abort main agent (session is saved)',
    stopKeep: 'Keep running',
    stopKeepDesc: 'Dismiss and continue (Esc)',
    firstRunTitle: (shell: string, web: string) =>
      `First run — confirm tools\n  shell [${shell}]  web [${web}]`,
    firstRunContinue: 'Continue',
    firstRunContinueDesc: 'Save and start',
    firstRunToggleShell: 'Toggle shell',
    firstRunToggleWeb: 'Toggle web',
    currently: (on: boolean) => (on ? 'Currently on' : 'Currently off'),
    skillsTitle: 'Skills — Enter to load · Esc cancel',
    profilesTitle: 'API profiles — Enter to select · Esc cancel',
    modelsTitle: 'Models — Enter to select · Esc cancel',
    reasoningTitle: 'Reasoning — Enter to select · Esc cancel',
    workflowsTitle: 'Workflows — Enter to arm · Esc cancel',
    jobsTitle: 'Jobs — Enter status · t tail · Esc cancel',
    spawnsTitle: 'Spawn presets — Enter detail · Esc cancel',
    langSet: (loc: string) => `UI language: ${loc === 'en' ? 'English' : 'Chinese'}`,
    langUsage: 'Usage: /lang zh|en',
    langStatus: (loc: string) =>
      `Language: ${loc === 'en' ? 'en (English)' : 'zh (Chinese)'} — /lang zh|en`,
  },
} as const;

export type UiMessageKey = keyof (typeof UI)['en'];

export function ui<K extends UiMessageKey>(
  locale: TuiLocale,
  key: K,
): (typeof UI)['zh'][K] | (typeof UI)['en'][K] {
  return (UI[locale][key] ?? UI.en[key]) as (typeof UI)['zh'][K] | (typeof UI)['en'][K];
}

export function localeLabel(locale: TuiLocale): string {
  return locale === 'en' ? 'en' : 'zh';
}
