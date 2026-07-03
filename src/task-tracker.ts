import { buildActionBlock } from './action-store.js';
import type { ActionBlock, ChatMessage, TaskSummaryDoc } from './types.js';

/**
 * A complete task block: user prompt → tool calls → final answer.
 */
export interface TaskBlock {
  task_id: string;
  session_id: string;
  turn_start: number;       // First turn of this task
  turn_end: number;         // Last turn of this task
  messages: ChatMessage[];  // All messages in this task (excluding system)
  tool_calls: Array<{ name: string; args: string }>;  // Tool calls made
}

/**
 * Task tracker: identifies task boundaries and collects task blocks.
 */
export class TaskTracker {
  private sessionId: string;
  private taskCounter = 0;
  private actionCounter = 0;
  private currentTask: TaskBlock | null = null;
  private completedTasks: TaskBlock[] = [];

  constructor(
    sessionId: string,
    initialTaskCount = 0,
    private readonly spawnParentSessionId?: string,
  ) {
    this.sessionId = sessionId;
    this.taskCounter = initialTaskCount;
  }

  /**
   * Generate a new task ID.
   */
  private generateTaskId(): string {
    this.taskCounter++;
    const shortHash = this.sessionId.slice(-6); // e.g. "272030" from "session_20260627203000"
    return `task_${shortHash}_${String(this.taskCounter).padStart(3, '0')}`;
  }

  /**
   * Called when a new user message arrives.
   * Starts a new task block if not already in one.
   */
  onUserMessage(message: ChatMessage, turn: number): void {
    // If there's an ongoing task without final answer, close it first
    if (this.currentTask && this.currentTask.messages.length > 0) {
      this.currentTask.turn_end = turn - 1;
      this.completedTasks.push(this.currentTask);
    }

    // Start new task
    this.actionCounter = 0;
    this.currentTask = {
      task_id: this.generateTaskId(),
      session_id: this.sessionId,
      turn_start: turn,
      turn_end: turn,
      messages: [message],
      tool_calls: [],
    };
  }

  private generateActionId(): string {
    this.actionCounter++;
    const shortHash = (this.currentTask?.task_id ?? this.sessionId).slice(-6);
    return `action_${shortHash}_${String(this.actionCounter).padStart(3, '0')}`;
  }

  /**
   * Record a tool invocation and build an ActionBlock for cold storage.
   */
  recordToolCall(
    toolName: string,
    argsJson: string,
    resultText: string,
    turn: number,
  ): ActionBlock | null {
    if (!this.currentTask) {
      return null;
    }

    const actionId = this.generateActionId();
    return buildActionBlock({
      action_id: actionId,
      task_id: this.currentTask.task_id,
      session_id: this.sessionId,
      turn_number: turn,
      tool_name: toolName,
      args_json: argsJson,
      result_text: resultText,
      spawn_parent_session_id: this.spawnParentSessionId,
    });
  }

  /**
   * Called when LLM returns a response (with or without tool calls).
   */
  onAssistantMessage(message: ChatMessage, turn: number): void {
    if (!this.currentTask) {
      return;
    }

    this.currentTask.turn_end = turn;
    this.currentTask.messages.push(message);

    // Collect tool calls
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        this.currentTask.tool_calls.push({
          name: call.function.name,
          args: call.function.arguments,
        });
      }
    }
  }

  /**
   * Called when a tool result is received.
   */
  onToolResult(message: ChatMessage): void {
    if (this.currentTask) {
      this.currentTask.messages.push(message);
    }
  }

  /**
   * Finalize the current task (called when LLM returns text without tool calls).
   * Returns the completed task block.
   */
  finalizeCurrentTask(): TaskBlock | null {
    if (!this.currentTask) {
      return null;
    }

    const task = this.currentTask;
    this.completedTasks.push(task);
    this.currentTask = null;
    return task;
  }

  /**
   * Get all completed task blocks.
   */
  getCompletedTasks(): TaskBlock[] {
    return [...this.completedTasks];
  }

  /**
   * Get the current ongoing task (if any).
   */
  getCurrentTask(): TaskBlock | null {
    return this.currentTask;
  }

  /**
   * Generate a TaskSummaryDoc from a completed TaskBlock.
   * Auto-extracted fields only (zero LLM cost).
   * Agent-supplemented fields (pending_tasks, current_work) are added later.
   */
  extractAutoFields(task: TaskBlock): Omit<TaskSummaryDoc, 'pending_tasks' | 'current_work'> {
    // Extract files touched from tool calls
    const filesTouched = new Set<string>();
    for (const call of task.tool_calls) {
      try {
        const args = JSON.parse(call.args);
        if (args.path) {
          filesTouched.add(args.path as string);
        }
      } catch {
        // Ignore invalid JSON
      }
    }

    // Extract tools used
    const toolsUsed = [...new Set(task.tool_calls.map(tc => tc.name))];

    // Infer tech concepts from file extensions
    const techConcepts = this.inferTechConcepts([...filesTouched]);

    // User intent: first user message
    const userMessages = task.messages.filter(m => m.role === 'user');
    const userIntent = userMessages[0]?.content ?? '';

    return {
      task_id: task.task_id,
      session_id: task.session_id,
      turn_range: [task.turn_start, task.turn_end],
      action_count: task.tool_calls.length,
      
      // Auto-extracted fields
      user_intent: userIntent as string,
      user_messages: userMessages.map(m => m.content ?? '').filter(Boolean),
      files_touched: [...filesTouched],
      tech_concepts: techConcepts,
      tools_used: toolsUsed,
    };
  }

  /**
   * Infer technology concepts from file extensions and names.
   */
  private inferTechConcepts(files: string[]): string[] {
    const conceptMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'React+TS',
      '.js': 'JavaScript',
      '.jsx': 'React',
      '.py': 'Python',
      '.rs': 'Rust',
      '.go': 'Go',
      '.json': 'JSON',
      '.md': 'Markdown',
      '.toml': 'TOML',
      '.yaml': 'YAML',
      '.yml': 'YAML',
    };

    const concepts = new Set<string>();
    for (const file of files) {
      const ext = file.slice(file.lastIndexOf('.'));
      if (ext in conceptMap) {
        concepts.add(conceptMap[ext]);
      }

      // Infer from filename patterns
      const basename = file.split('/').pop() ?? file;
      if (basename.includes('package.json')) concepts.add('Node.js');
      if (basename.includes('tsconfig')) concepts.add('TypeScript');
      if (basename.includes('.env')) concepts.add('Environment Config');
    }

    return [...concepts];
  }
}
