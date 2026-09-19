import type { TaskState, VerificationEvidence, VerificationPolicy, VerificationStatus, VerificationSummary } from "./types.ts";

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

/** 只管理任务事实和状态迁移；工具执行、事件持久化由 Agent 负责。 */
export class TaskStateMachine {
  readonly policy: VerificationPolicy;
  private stateValue: TaskState = "received";
  private writeObservedValue = false;
  private verificationPassedValue = false;
  private verifierToolValue?: string;
  private verificationAttemptsValue = 0;
  private repairAttemptsValue = 0;
  private statusValue: VerificationStatus = "not_required";
  private readonly evidenceValue: VerificationEvidence[] = [];
  private readonly onTransition?: (from: TaskState, to: TaskState, reason: string) => void | Promise<void>;

  constructor(policy: VerificationPolicy, onTransition?: (from: TaskState, to: TaskState, reason: string) => void | Promise<void>) {
    const maxRepairAttempts = policy.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 1) throw new Error("maxRepairAttempts must be a positive integer");
    this.policy = { ...policy, maxRepairAttempts };
    this.onTransition = onTransition;
  }

  get state(): TaskState { return this.stateValue; }
  get isBlocked(): boolean { return this.stateValue === "blocked"; }
  get requiresVerification(): boolean { return this.writeObservedValue && !this.verificationPassedValue; }

  async start(): Promise<void> { await this.transition("working", "task started"); }

  async beginWork(): Promise<void> {
    if (this.stateValue === "repairing") await this.transition("working", "repair attempt started");
  }

  async observeWrite(toolName: string): Promise<void> {
    this.ensureMutable("observe a write");
    this.writeObservedValue = true;
    this.verificationPassedValue = false;
    this.statusValue = "pending";
    this.verifierToolValue = undefined;
    await this.transition("verifying", `write tool completed: ${toolName}`);
  }

  async observeVerification(toolName: string, evidence: VerificationEvidence): Promise<void> {
    this.ensureMutable("observe verification");
    // 没有成功写入时，验证工具只是普通工具调用，不应把只读任务强行推进到验证态。
    if (!this.writeObservedValue) return;
    this.verificationAttemptsValue += 1;
    this.verifierToolValue = toolName;
    this.evidenceValue.push(evidence);
    this.statusValue = evidence.status;
    if (evidence.status === "passed") {
      this.verificationPassedValue = true;
      await this.transition("verifying", `verification passed: ${toolName}`);
      return;
    }
    this.verificationPassedValue = false;
    this.repairAttemptsValue += 1;
    if (this.repairAttemptsValue >= this.policy.maxRepairAttempts!) {
      await this.block("verification repair limit reached");
      return;
    }
    await this.transition("repairing", `verification failed: ${toolName}`);
  }

  /** 模型在有未验证写入时收尾，给它有限次数补救机会。 */
  async noteVerificationRequired(): Promise<void> {
    if (this.isBlocked || !this.requiresVerification) return;
    this.repairAttemptsValue += 1;
    if (this.repairAttemptsValue >= this.policy.maxRepairAttempts!) {
      await this.block("model completed without verification");
      return;
    }
    await this.transition("repairing", "verification required before completion");
  }

  async complete(): Promise<boolean> {
    if (this.isBlocked || this.requiresVerification) return false;
    await this.transition("completed", "task completed");
    return true;
  }

  async block(reason: string): Promise<void> {
    if (this.stateValue === "completed") throw new Error("Completed task cannot be blocked");
    await this.transition("blocked", reason);
  }

  summary(): VerificationSummary {
    return {
      required: this.writeObservedValue,
      writeObserved: this.writeObservedValue,
      status: this.statusValue,
      ...(this.verifierToolValue ? { verifierTool: this.verifierToolValue } : {}),
      verificationPassed: this.verificationPassedValue,
      verificationAttempts: this.verificationAttemptsValue,
      repairAttempts: this.repairAttemptsValue,
      evidence: [...this.evidenceValue],
    };
  }

  private ensureMutable(action: string): void {
    if (this.stateValue === "completed") throw new Error(`Completed task cannot ${action}`);
    if (this.stateValue === "blocked") throw new Error(`Blocked task cannot ${action}`);
  }

  private async transition(next: TaskState, reason: string): Promise<void> {
    if (this.stateValue === next) return;
    if (!allowedTransitions[this.stateValue].includes(next)) throw new Error(`Invalid task state transition: ${this.stateValue} -> ${next}`);
    const previous = this.stateValue;
    this.stateValue = next;
    await this.onTransition?.(previous, next, reason);
  }
}

const allowedTransitions: Record<TaskState, readonly TaskState[]> = {
  received: ["working", "blocked"],
  working: ["verifying", "completed", "repairing", "blocked"],
  verifying: ["repairing", "completed", "blocked"],
  repairing: ["working", "verifying", "completed", "blocked"],
  completed: [],
  blocked: [],
};

export { DEFAULT_MAX_REPAIR_ATTEMPTS };
