export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'in_review' | 'approved' | 'rejected'
export type ThreatStatus = 'open' | 'mitigating' | 'mitigated' | 'accepted'
export type ControlStatus = 'effective' | 'degraded' | 'failed' | 'planned'
export type ActorRole = 'development' | 'security' | 'business'
export type DecisionType = 'accept' | 'degrade' | 'evidence_required' | 'approved' | 'rejected'
/**
 * 会签意见在统一版本链中的有效性。
 * - active：与当前威胁会签基准一致，仍然生效
 * - invalidated：威胁引用的缓解任务、控制证据或风险值等发生改动，意见已失效，仅可查看
 * - superseded：同一角色在同一基准下提交了新意见，旧意见被覆盖，仅可查看
 */
export type DecisionValidity = 'active' | 'invalidated' | 'superseded'

/** 触发会签基准失效的来源 */
export type InvalidationReason =
  | 'mitigation'
  | 'control'
  | 'evidence'
  | 'risk'
  | 'threat'
  | 'version'

export interface SystemBoundary {
  id: string
  name: string
  description: string
  owner: string
  inScope: string
  outOfScope: string
}

export interface TrustZone {
  id: string
  name: string
  level: 'internet' | 'dmz' | 'internal' | 'restricted'
  description: string
}

export interface ArchitectureComponent {
  id: string
  name: string
  type: 'service' | 'asset' | 'data_store' | 'gateway' | 'client'
  zoneId: string
  criticality: Severity
  owner: string
  description: string
}

export interface ExternalDependency {
  id: string
  name: string
  vendor: string
  purpose: string
  dataClass: 'public' | 'internal' | 'confidential' | 'restricted'
  owner: string
  status: 'active' | 'review_due' | 'retired'
}

export interface DataFlow {
  id: string
  name: string
  sourceId: string
  targetId: string
  protocol: string
  dataClass: 'public' | 'internal' | 'confidential' | 'restricted'
  crossesTrustBoundary: boolean
  description: string
}

export interface ControlEvidence {
  id: string
  controlId: string
  title: string
  kind: 'test' | 'config' | 'ticket' | 'scan' | 'attestation'
  reference: string
  collectedAt: string
  expiresAt: string
  owner: string
  valid: boolean
}

export interface SecurityControl {
  id: string
  name: string
  type: 'preventive' | 'detective' | 'corrective'
  status: ControlStatus
  owner: string
  componentId: string
  description: string
  evidenceIds: string[]
}

export interface AttackPath {
  id: string
  name: string
  entryPoint: string
  target: string
  steps: string[]
  likelihood: 1 | 2 | 3 | 4 | 5
}

export interface Risk {
  id: string
  code: string
  title: string
  likelihood: 1 | 2 | 3 | 4 | 5
  impact: 1 | 2 | 3 | 4 | 5
  status: 'open' | 'mitigating' | 'accepted' | 'closed'
  owner: string
  acceptanceExpiresAt?: string
  acceptanceCondition?: string
}

export interface Threat {
  id: string
  code: string
  title: string
  category: 'spoofing' | 'tampering' | 'repudiation' | 'information_disclosure' | 'denial_of_service' | 'elevation'
  description: string
  severity: Severity
  status: ThreatStatus
  componentIds: string[]
  flowIds: string[]
  externalDependencyIds: string[]
  attackPathIds: string[]
  controlIds: string[]
  riskIds: string[]
  reviewStatus: ReviewStatus
  revision: number
  /** 当前会签基准（缓解任务/控制/证据/风险内容）的指纹，意见指纹与此一致才生效 */
  basisFingerprint: string
  /** 版本链令牌：创建版本快照时，受影响威胁会重新生成令牌，用于把快照变更接入版本链 */
  chainToken: string
  /** 是否处于“会签失效、待重新会签”队列 */
  invalidationPending: boolean
  /** 最近一次使该威胁会签失效的来源类型 */
  lastInvalidationReason: InvalidationReason | null
  /** 最近一次失效时间（ISO） */
  lastInvalidatedAt: string | null
}

export interface MitigationTask {
  id: string
  threatId: string
  title: string
  owner: string
  dueAt: string
  status: 'todo' | 'in_progress' | 'verifying' | 'done'
  action: 'restrict' | 'monitor' | 'encrypt' | 'isolate' | 'allow_with_condition'
  detail: string
  evidenceIds: string[]
  conflictGroup?: string
}

export interface ReviewDecision {
  id: string
  threatId: string
  actor: string
  role: ActorRole
  decision: DecisionType
  comment: string
  createdAt: string
  revision: number
  /** 提交时威胁的会签基准指纹 */
  basisFingerprint: string
  /** 在版本链中的有效性；旧版本意见失效后保留记录但只能查看 */
  validity: DecisionValidity
  /** 失效/被覆盖的时间（ISO） */
  invalidatedAt: string | null
  /** 失效原因 */
  invalidationReason: InvalidationReason | null
}

export interface VersionSnapshot {
  id: string
  revision: number
  label: string
  createdAt: string
  author: string
  notes: string
  threatIds: string[]
  componentIds: string[]
  flowIds: string[]
  controlIds: string[]
  riskIds: string[]
  mitigationIds: string[]
  evidenceIds: string[]
  affectedThreatIds: string[]
  /** 快照时刻各威胁的会签基准指纹，用于版本比较页展示会签基准变化 */
  basisFingerprints: Record<string, string>
}

/** 一次变更引起的会签失效范围记录，是会签页与版本比较页共享的“失效范围”数据源 */
export interface InvalidationRecord {
  id: string
  createdAt: string
  actor: string
  reason: InvalidationReason
  /** 人类可读的变更来源，如缓解任务名称、证据标题、风险编号 */
  sourceLabel: string
  /** 受影响、回到待重新会签的威胁 */
  threatIds: string[]
  /** 因此次变更而失效的会签意见 */
  decisionIds: string[]
  /** 关联版本快照（若失效由创建版本触发） */
  versionId?: string
  /** 与冲突版本相关时，记录对方窗口的写入令牌 */
  remoteWriteToken?: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  createdAt: string
  detail: string
}

export interface ThreatModelState {
  boundary: SystemBoundary
  zones: TrustZone[]
  components: ArchitectureComponent[]
  dependencies: ExternalDependency[]
  flows: DataFlow[]
  controls: SecurityControl[]
  evidence: ControlEvidence[]
  threats: Threat[]
  attackPaths: AttackPath[]
  risks: Risk[]
  mitigations: MitigationTask[]
  decisions: ReviewDecision[]
  versions: VersionSnapshot[]
  invalidations: InvalidationRecord[]
  audit: AuditEvent[]
  currentRevision: number
}

/** localStorage 持久化信封，writeToken 用于多窗口乐观并发控制 */
export interface StoredEnvelope {
  schema: 2
  writeToken: string
  updatedAt: string
  state: ThreatModelState
}

/** 乐观锁冲突：另一个窗口已先提交，携带对方版本供比较 */
export interface WriteConflict {
  expectedToken: string
  remoteWriteToken: string
  remoteUpdatedAt: string
  remoteState: ThreatModelState
}

/** 写入失败/冲突时保留的草稿，独立于主数据持久化，重启后恢复 */
export interface DraftPayload {
  id: string
  kind:
    | 'mitigation'
    | 'evidence'
    | 'decision'
    | 'version'
    | 'risk_acceptance'
    | 'mitigation_status'
  title: string
  route: string
  payload: unknown
  contextId?: string
  reason: 'write_failed' | 'conflict'
  detail: string
  createdAt: string
}

/** 会签失效范围的单一视图模型，会签页与版本比较页共用 */
export interface InvalidationScopeItem {
  threatId: string
  threatCode: string
  threatTitle: string
  reasons: InvalidationReason[]
  invalidatedDecisionCount: number
  lastInvalidatedAt: string | null
}

export interface ValidationIssue {
  id: string
  kind: 'uncovered_component' | 'control_failed' | 'risk_acceptance_expired' | 'mitigation_conflict' | 'missing_evidence'
  severity: Severity
  title: string
  detail: string
  entityId: string
}

export interface VersionChange {
  category: string
  id: string
}

export interface VersionDifference {
  added: VersionChange[]
  removed: VersionChange[]
  changed: string[]
  /** 两快照之间会签基准发生变化的威胁 id（即版本链上的失效范围） */
  basisChangedThreatIds: string[]
}
