/**
 * 适配器注册表（SPEC §3）：内置与生成的数据适配器的唯一事实来源，
 * 提供「激活 / 切换 / 热加载」语义。
 *
 * W1：内置 sqlite-demo 的激活与状态查询（inv_adapter_status 的数据来源）；
 * W3：元流程产物（adapters/generated/）经校验后动态 import 热加载并重绑定，
 * 切换历史与校验结果随状态可查（SPEC §5.2 第 5 步）。
 *
 * 适配器以纯模块形态（JcInventoryAdapterModule）持有，不是 Cordis 插件，
 * 避免「热加载与 Cordis 生命周期冲突」（SPEC §14 对策）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AdapterConnectOptions, AdapterDialect, AdapterInfo, JcInventoryAdapterModule, JcInventoryData } from '../contract.ts'
import { importGeneratedModule } from '../meta/generate.ts'
import { sqliteDemoAdapter } from './sqlite-demo.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jcInventoryAdapters: JcInventoryAdapterRegistry
  }
}

/** inv_adapter_status 的一行切换历史。type alias（非 interface）以获得对 JsonValue 的隐式索引签名。 */
export type AdapterSwitchRecord = {
  name: string
  origin: AdapterInfo['origin']
  event: 'activated' | 'unavailable' | 'deactivated'
  /** 事件时刻，ISO 8601。 */
  at: string
  /** 补充说明（如连接失败原因）。 */
  detail?: string
}

/** inv_adapter_status 的输出结构。 */
export type AdapterStatus = {
  current: {
    name: string
    dialect: AdapterInfo['dialect']
    origin: AdapterInfo['origin']
    description: string
    /** 契约实现是否可用（连接成功）。 */
    available: boolean
    activatedAt: string
    /** available 为 false 时的原因。 */
    unavailableReason: string | null
  }
  history: AdapterSwitchRecord[]
}

/** 内置适配器表；W3 的生成产物经校验确认后另行注册进 registry。 */
const BUILTIN_ADAPTERS: Readonly<Record<string, JcInventoryAdapterModule>> = {
  [sqliteDemoAdapter.info.name]: sqliteDemoAdapter,
}

/** 启动即激活的内置适配器名。 */
const DEFAULT_ADAPTER = sqliteDemoAdapter.info.name

export default class JcInventoryAdapterRegistry extends Service {
  /** TS private 而非 #私有字段：ctx.jcInventoryAdapters 经 cordis traceable proxy 访问（SPEC §9.8.5）。 */
  private activeModule: JcInventoryAdapterModule | null = null
  private activeData: JcInventoryData | null = null
  private activeInfo: AdapterInfo | null = null
  private activeError: string | null = null
  private activatedAt = ''
  private readonly history: AdapterSwitchRecord[] = []
  /** 最近一次接入连接（inv_regenerate_adapter 对当前连接重跑生成用）。 */
  private lastConnect: { name: string; dialect: AdapterDialect; options: AdapterConnectOptions } | null = null

  constructor(ctx: Context) {
    super(ctx, 'jcInventoryAdapters')
  }

  async [Service.init](): Promise<void> {
    await this.activateBuiltin(DEFAULT_ADAPTER)
  }

  /** 当前契约实现是否可用。 */
  get available(): boolean {
    return this.activeData !== null
  }

  /**
   * 当前激活的契约实现。
   * @throws 数据源不可用时抛出带原因的错误（业务工具统一转述为不可用提示）。
   */
  require(): JcInventoryData {
    if (this.activeData === null) {
      throw new Error(`库存数据源不可用：${this.activeError ?? '尚未激活任何适配器'}`)
    }
    return this.activeData
  }

  /** 供 inv_adapter_status 消费的完整状态。 */
  status(): AdapterStatus {
    const info = this.activeInfo
    return {
      current: {
        name: info?.name ?? '',
        dialect: info?.dialect ?? 'sqlite',
        origin: info?.origin ?? 'builtin',
        description: info?.description ?? '',
        available: this.activeData !== null,
        activatedAt: this.activatedAt,
        unavailableReason: this.activeError,
      },
      history: [...this.history],
    }
  }

  /**
   * 重新激活默认内置适配器（sqlite-demo）：inv_prepare_demo_db 生成演示库后调用，
   * 让 jcInventoryData 重绑定到新生成的 data/jc.db。
   */
  async reactivateDefault(): Promise<void> {
    await this.activateBuiltin(DEFAULT_ADAPTER)
  }

  /**
   * 激活一个内置适配器。连接失败不抛出：registry 服务保持可用，
   * 状态记录原因，业务工具在查询时统一得到不可用提示（fail loud but not crash）。
   */
  private async activateBuiltin(name: string, options?: AdapterConnectOptions): Promise<void> {
    const module = BUILTIN_ADAPTERS[name]
    if (module === undefined) {
      this.record(name, 'builtin', 'unavailable', `未注册的内置适配器：${name}`)
      return
    }
    const at = new Date().toISOString()
    try {
      const data = await module.connect(options)
      this.activeModule = module
      this.swap(module.info, data, at)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.activeData = null
      this.activeInfo = module.info
      this.activeError = reason
      this.activatedAt = at
      this.record(module.info.name, module.info.origin, 'unavailable', reason)
      this.ctx.logger.warn(`[jc-inventory] 适配器 ${name} 连接失败：${reason}`)
    }
  }

  /**
   * 激活一个元流程产物（SPEC §5.2 第 5 步）：动态 import 带缓存戳热加载，
   * origin/name/dialect 由 registry 盖章（不信任生成代码自述），connect 成功
   * 即重绑定 jcInventoryData。激活失败保留原适配器继续服务，失败只记历史。
   */
  async activateGenerated(name: string, dialect: AdapterDialect, options: AdapterConnectOptions): Promise<void> {
    const at = new Date().toISOString()
    try {
      const raw = await importGeneratedModule(name)
      const module: JcInventoryAdapterModule = {
        ...raw,
        info: { ...raw.info, name, dialect, origin: 'generated', description: raw.info.description || '元流程生成的数据适配器' },
      }
      const data = await module.connect(options)
      this.activeModule = module
      this.lastConnect = { name, dialect, options }
      this.swap(module.info, data, at)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.record(name, 'generated', 'unavailable', reason)
      this.ctx.logger.warn(`[jc-inventory] 生成适配器 ${name} 激活失败：${reason}`)
    }
  }

  /** 最近一次接入连接；未接入过（仅内置演示适配器）为 null。 */
  get currentConnection(): { name: string; dialect: AdapterDialect; options: AdapterConnectOptions } | null {
    return this.lastConnect
  }

  /** 记住一次接入连接（生成循环结束后、激活确认前调用，供 regenerate 复用）。 */
  rememberConnection(name: string, dialect: AdapterDialect, options: AdapterConnectOptions): void {
    this.lastConnect = { name, dialect, options }
  }

  /** 切换激活实现：先断开旧连接，再登记新实现（重绑定而非重复注册）。 */
  private swap(info: AdapterInfo, data: JcInventoryData, at: string): void {
    const previous = this.activeData
    const previousModule = this.activeModule
    if (previous !== null && previousModule !== null) {
      previousModule.disconnect?.(previous)
      this.record(previousModule.info.name, previousModule.info.origin, 'deactivated')
    }
    this.activeData = data
    this.activeInfo = info
    this.activeError = null
    this.activatedAt = at
    this.record(info.name, info.origin, 'activated')
    this.ctx.logger.info(`[jc-inventory] 数据源已激活：${info.name}（${info.dialect}）`)
  }

  private record(name: string, origin: AdapterInfo['origin'], event: AdapterSwitchRecord['event'], detail?: string): void {
    this.history.push({ name, origin, event, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) })
  }
}
