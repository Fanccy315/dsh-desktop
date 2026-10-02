/**
 * jcInventoryData 服务（SPEC §3）：业务层访问库存数据的唯一入口，
 * 代理到 registry 当前激活的适配器。
 *
 * 业务工具 `inject: ['tools', 'jcInventoryData']` 调用本服务，
 * 永远不直接开数据库连接、不知道当前库是什么引擎；
 * 适配器切换后本服务的代理目标随之重绑定，业务工具立即对新库工作。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AdapterStatus } from './adapters/registry.ts'
import type { JcInventoryData } from './contract.ts'
import type {
  AlertFilter,
  AlertRow,
  AlertStatus,
  BomLine,
  DailyOutflow,
  InboundOrder,
  InboundQuery,
  Material,
  MaterialQuery,
  Movement,
  MovementQuery,
  MovementTotal,
  MovementTotalQuery,
  NewAlert,
  NewSuggestion,
  StockQuery,
  StockView,
  SuggestionDecision,
  SuggestionRow,
  SuggestionStatus,
  WorkOrder,
  WorkOrderQuery,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jcInventoryData: JcInventoryDataService
  }
}

export default class JcInventoryDataService extends Service {
  static inject = ['jcInventoryAdapters']

  constructor(ctx: Context) {
    super(ctx, 'jcInventoryData')
  }

  /** 数据源是否可用（连接成功且契约实现就绪）。 */
  get available(): boolean {
    return this.ctx.jcInventoryAdapters.available
  }

  /** 当前数据源状态（inv_adapter_status 的数据来源）。 */
  status(): AdapterStatus {
    return this.ctx.jcInventoryAdapters.status()
  }

  /** 当前契约实现；不可用时抛带原因错误。 */
  private current(): JcInventoryData {
    return this.ctx.jcInventoryAdapters.require()
  }

  listMaterials(query?: MaterialQuery): Material[] {
    return this.current().listMaterials(query)
  }

  getBom(parentSku: string): BomLine[] {
    return this.current().getBom(parentSku)
  }

  getStockViews(query?: StockQuery): StockView[] {
    return this.current().getStockViews(query)
  }

  getMovements(query?: MovementQuery): Movement[] {
    return this.current().getMovements(query)
  }

  getMovementTotals(query: MovementTotalQuery): MovementTotal[] {
    return this.current().getMovementTotals(query)
  }

  getDailyOutflow(sku: string, days: number): DailyOutflow[] {
    return this.current().getDailyOutflow(sku, days)
  }

  getOpenWorkOrders(query?: WorkOrderQuery): WorkOrder[] {
    return this.current().getOpenWorkOrders(query)
  }

  getInboundOrders(query?: InboundQuery): InboundOrder[] {
    return this.current().getInboundOrders(query)
  }

  writeAlert(alert: NewAlert): number {
    return this.current().writeAlert(alert)
  }

  findOpenAlert(type: NewAlert['type'], sku: string | null): AlertRow | null {
    return this.current().findOpenAlert(type, sku)
  }

  listAlerts(filter?: AlertFilter): AlertRow[] {
    return this.current().listAlerts(filter)
  }

  updateAlertStatus(id: number, status: AlertStatus): AlertRow | null {
    return this.current().updateAlertStatus(id, status)
  }

  writeSuggestion(suggestion: NewSuggestion): number {
    return this.current().writeSuggestion(suggestion)
  }

  findPendingSuggestion(sku: string): SuggestionRow | null {
    return this.current().findPendingSuggestion(sku)
  }

  listSuggestions(status?: SuggestionStatus): SuggestionRow[] {
    return this.current().listSuggestions(status)
  }

  decideSuggestion(id: number, action: SuggestionDecision, note?: string): SuggestionRow | null {
    return this.current().decideSuggestion(id, action, note)
  }

  getNumberSetting(key: string, fallback: number): number {
    return this.current().getNumberSetting(key, fallback)
  }
}
