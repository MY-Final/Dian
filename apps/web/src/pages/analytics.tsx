import { useCallback, useEffect, useMemo, useState } from "react"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  LabelList,
  Cell,
} from "recharts"
import {
  Users,
  MessageSquare,
  Hash,
  Bot,
  RefreshCw,
  Loader2,
  CalendarDays,
  Wifi,
  WifiOff,
} from "lucide-react"
import {
  statsApi,
  type GroupNameMap,
  type OverviewStats,
  type GroupStat,
  type UserStat,
  type TrendPoint,
  type StatsFilter,
} from "@/lib/api"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// ─── 时间范围选项 ─────────────────────────────────────────────────────────────

const RANGES = [
  { label: "今天",  days: 1 },
  { label: "7 天",  days: 7 },
  { label: "30 天", days: 30 },
  { label: "全部",  days: 0 },
] as const

function rangeToFilter(days: number): Pick<StatsFilter, "from" | "to"> {
  if (days === 0) return {}
  const now = Math.floor(Date.now() / 1000)
  return { from: now - days * 86400, to: now }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000)  return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
}

function localDateKey(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** 显示名：优先群名，否则原 ID */
function groupLabel(id: string, names: GroupNameMap): string {
  return names[id] ?? id
}

/** 支持换行的 Y 轴自定义 tick，每行最多 8 个字符 */
function WrapTick(props: { x?: number; y?: number; payload?: { value: string } }) {
  const { x = 0, y = 0, payload } = props
  const text = payload?.value ?? ""
  const chunkSize = 8
  const lines: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    lines.push(text.slice(i, i + chunkSize))
  }
  const lineHeight = 14
  const totalHeight = lines.length * lineHeight
  return (
    <g transform={`translate(${x},${y})`}>
      {lines.map((line, i) => (
        <text
          key={i}
          x={0}
          y={i * lineHeight - totalHeight / 2 + lineHeight / 2}
          textAnchor="end"
          fontSize={11}
          fill="hsl(var(--muted-foreground))"
        >
          {line}
        </text>
      ))}
    </g>
  )
}

// ─── 卡片骨架 ─────────────────────────────────────────────────────────────────

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20 mb-1" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  )
}

// ─── 自定义 Tooltip（趋势图） ─────────────────────────────────────────────────

function TrendTooltip({ active, payload, label }: {
  active?: boolean
  payload?: { value: number }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-sm shadow-md">
      <p className="mb-1 font-medium text-card-foreground">{label}</p>
      <p className="text-muted-foreground">
        消息数：<span className="font-semibold text-foreground">{payload[0].value.toLocaleString()}</span>
      </p>
    </div>
  )
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const [rangeDays, setRangeDays]       = useState<number>(7)
  const [loading, setLoading]           = useState(false)
  const [overview, setOverview]         = useState<OverviewStats | null>(null)
  const [groups, setGroups]             = useState<GroupStat[]>([])
  const [users, setUsers]               = useState<UserStat[]>([])
  const [trend, setTrend]               = useState<TrendPoint[]>([])
  const [error, setError]               = useState<string | null>(null)

  // 群名缓存
  const [groupNames, setGroupNames]     = useState<GroupNameMap>({})
  const [syncingNames, setSyncingNames] = useState(false)
  const [lastSync, setLastSync]         = useState<string | null>(null)

  // 群过滤下钻
  const [drillGroup, setDrillGroup]     = useState<string | null>(null)

  // 构建 filter
  const filter = useMemo<StatsFilter>(() => ({
    ...rangeToFilter(rangeDays),
    ...(drillGroup ? { groupId: drillGroup } : {}),
  }), [rangeDays, drillGroup])

  // 拉取所有 stats + 群名
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [ov, gr, us, tr, names] = await Promise.all([
        statsApi.overview(filter),
        statsApi.byGroup({ ...filter, limit: 15 }),
        statsApi.byUser({ ...filter, limit: 15 }),
        statsApi.trend(filter),
        statsApi.groupNames(),            // 拉取全部已缓存群名
      ])
      setOverview(ov)
      setGroups(gr.groups)
      setUsers(us.users)
      setTrend(tr.trend)
      setGroupNames(names)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { void refresh() }, [refresh])

  // 同步群名（触发 bot get_group_list）
  const handleSyncNames = useCallback(async () => {
    setSyncingNames(true)
    try {
      const res = await statsApi.syncGroupNames()
      const names = await statsApi.groupNames()
      setGroupNames(names)
      setLastSync(`已同步 ${res.synced} 个群`)
    } catch (e) {
      setLastSync(`同步失败：${(e as Error).message}`)
    } finally {
      setSyncingNames(false)
      setTimeout(() => setLastSync(null), 4000)
    }
  }, [])

  // 趋势图：若范围 <= 7 天，补全所有日期（避免缺口）
  const trendFilled = useMemo(() => {
    if (rangeDays === 0 || rangeDays > 7) return trend
    const map = new Map(trend.map((p) => [p.date, p.count]))
    const now = Date.now()
    const filled: TrendPoint[] = []
    for (let i = rangeDays - 1; i >= 0; i--) {
      const d = localDateKey(now - i * 86400_000)
      filled.push({ date: d, count: map.get(d) ?? 0 })
    }
    return filled
  }, [trend, rangeDays])

  // 群组图表数据（含名称、百分比）
  const groupChartData = useMemo(() => {
    const total = groups.reduce((s, g) => s + g.count, 0) || 1
    return groups.map((g) => ({
      id:      g.groupId,
      name:    groupLabel(g.groupId, groupNames),
      count:   g.count,
      lastAt:  g.lastAt,
      pct:     Math.round((g.count / total) * 100),
    }))
  }, [groups, groupNames])

  // 用户图表数据（含百分比）
  const userChartData = useMemo(() => {
    const total = users.reduce((s, u) => s + u.count, 0) || 1
    return users.map((u) => ({
      name:   u.senderName || u.userId,
      uid:    u.userId,
      count:  u.count,
      lastAt: u.lastAt,
      pct:    Math.round((u.count / total) * 100),
    }))
  }, [users])

  const isDrillDown = drillGroup !== null

  return (
    <div className="flex flex-col gap-6 p-6">

      {/* ── 顶部：标题 + 操作栏 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">消息统计</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {RANGES.find((r) => r.days === rangeDays)?.label ?? "自定义"}
            {isDrillDown && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                <Hash className="h-3 w-3" />
                {groupLabel(drillGroup!, groupNames)}
                <button onClick={() => setDrillGroup(null)} className="ml-0.5 hover:opacity-70">×</button>
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* 时间范围选择器 */}
          <div className="flex rounded-md border overflow-hidden text-sm">
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setRangeDays(r.days)}
                className={cn(
                  "cursor-pointer px-3 py-1.5 transition-colors",
                  rangeDays === r.days
                    ? "bg-primary text-primary-foreground font-medium"
                    : "hover:bg-muted text-muted-foreground"
                )}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* 同步群名 */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSyncNames()}
            disabled={syncingNames}
            title="向机器人同步群名称"
          >
            {syncingNames
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Wifi className="h-4 w-4" />}
            <span className="ml-1 hidden sm:inline text-xs">同步群名</span>
          </Button>

          {/* 刷新 */}
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* 同步结果提示 */}
      {lastSync && (
        <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <Wifi className="h-4 w-4 shrink-0" />
          {lastSync}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2">
          <WifiOff className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ── 概览卡片 ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {!overview ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <OverviewCard
              icon={<MessageSquare className="h-4 w-4" />}
              label="消息总量"
              value={fmtNum(overview.total)}
              sub={`${overview.total.toLocaleString()} 条`}
              color="text-blue-500"
              bgColor="bg-blue-500/10 dark:bg-blue-500/20"
            />
            <OverviewCard
              icon={<Hash className="h-4 w-4" />}
              label="活跃群聊"
              value={fmtNum(overview.groups)}
              sub={`共 ${overview.groups} 个群`}
              color="text-emerald-500"
              bgColor="bg-emerald-500/10 dark:bg-emerald-500/20"
            />
            <OverviewCard
              icon={<Users className="h-4 w-4" />}
              label="活跃用户"
              value={fmtNum(overview.users)}
              sub={`共 ${overview.users} 人`}
              color="text-violet-500"
              bgColor="bg-violet-500/10 dark:bg-violet-500/20"
            />
            {/* 机器人分布卡片 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                  <Bot className="h-4 w-4 text-amber-500" />
                  机器人分布
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                {overview.byBot.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无数据</p>
                ) : (() => {
                  const total = overview.byBot.reduce((s, b) => s + b.count, 0) || 1
                  return overview.byBot.map((b) => (
                    <div key={b.botId} className="space-y-0.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="truncate max-w-[7rem] text-muted-foreground">{b.botId}</span>
                        <span className="text-foreground font-medium">{fmtNum(b.count)}</span>
                      </div>
                      <div className="h-1 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-400"
                          style={{ width: `${Math.round((b.count / total) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))
                })()}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* ── 趋势图 ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            消息趋势（按天）
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!overview ? (
            <Skeleton className="h-48 w-full" />
          ) : trendFilled.length === 0 ? (
            <EmptyState text="该时间范围内暂无数据" />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trendFilled} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                <Tooltip content={<TrendTooltip />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  fill="url(#trendGrad)"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── 群组 + 用户并排 ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 items-start">

        {/* Top 群聊 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Hash className="h-4 w-4 text-emerald-500" />
              最活跃群聊 Top 15
              {Object.keys(groupNames).length > 0 && (
                <Badge variant="secondary" className="ml-auto text-xs font-normal">已加载群名</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!overview ? (
              <Skeleton className="h-64 w-full" />
            ) : groupChartData.length === 0 ? (
              <EmptyState text="暂无群消息数据" />
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-2">
                  点击群组可下钻查看该群用户统计
                </p>
                <ResponsiveContainer width="100%" height={Math.max(groupChartData.length * 40 + 24, 160)}>
                  <BarChart
                    layout="vertical"
                    data={groupChartData}
                    margin={{ top: 0, right: 52, bottom: 0, left: 8 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={80}
                      tick={<WrapTick />}
                      interval={0}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const d = payload[0].payload as { id: string; name: string; count: number; lastAt: number; pct: number }
                        const hasName = d.name !== d.id
                        return (
                          <div className="rounded-lg border bg-card px-3 py-2 text-sm shadow-md min-w-[140px]">
                            <p className="font-medium">{d.name}</p>
                            {hasName && <p className="text-xs text-muted-foreground">群号：{d.id}</p>}
                            <p className="text-muted-foreground mt-1">
                              消息数：<span className="font-semibold text-foreground">{d.count.toLocaleString()}</span>
                              <span className="ml-1 text-xs text-muted-foreground">({d.pct}%)</span>
                            </p>
                            <p className="text-muted-foreground">最近：{fmtDate(d.lastAt)}</p>
                            <p className="text-xs text-muted-foreground mt-1 opacity-70">点击下钻 / 再次点击取消</p>
                          </div>
                        )
                      }}
                    />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={22}
                      onClick={(data) => {
                        const id = (data as { id?: string })?.id
                        if (id) {
                          setDrillGroup((prev) => prev === id ? null : id)
                        }
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      {groupChartData.map((d) => (
                        <Cell
                          key={d.id}
                          fill={
                            drillGroup === d.id
                              ? "var(--chart-3)"
                              : "oklch(0.696 0.17 162.48)"
                          }
                          opacity={drillGroup && drillGroup !== d.id ? 0.5 : 1}
                        />
                      ))}
                      <LabelList
                        dataKey="count"
                        position="right"
                        style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                        formatter={(v: unknown) => fmtNum(Number(v))}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </CardContent>
        </Card>

        {/* Top 用户 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-violet-500" />
              最活跃用户 Top 15
              {isDrillDown && (
                <Badge variant="outline" className="ml-auto text-xs font-normal text-emerald-600 border-emerald-300">
                  {groupLabel(drillGroup!, groupNames)}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!overview ? (
              <Skeleton className="h-64 w-full" />
            ) : userChartData.length === 0 ? (
              <EmptyState text="暂无用户消息数据" />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(userChartData.length * 40 + 24, 160)}>
                <BarChart
                  layout="vertical"
                  data={userChartData}
                  margin={{ top: 0, right: 52, bottom: 0, left: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={80}
                    tick={<WrapTick />}
                    interval={0}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0].payload as { name: string; uid: string; count: number; lastAt: number; pct: number }
                      return (
                        <div className="rounded-lg border bg-card px-3 py-2 text-sm shadow-md min-w-[140px]">
                          <p className="font-medium">{d.name}</p>
                          {d.uid !== d.name && <p className="text-xs text-muted-foreground">QQ：{d.uid}</p>}
                          <p className="text-muted-foreground mt-1">
                            消息数：<span className="font-semibold text-foreground">{d.count.toLocaleString()}</span>
                            <span className="ml-1 text-xs text-muted-foreground">({d.pct}%)</span>
                          </p>
                          <p className="text-muted-foreground">最近：{fmtDate(d.lastAt)}</p>
                        </div>
                      )
                    }}
                  />
                  <Bar dataKey="count" fill="var(--chart-1)" radius={[0, 3, 3, 0]} maxBarSize={22}>
                    <LabelList
                      dataKey="count"
                      position="right"
                      style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      formatter={(v: unknown) => fmtNum(Number(v))}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 底部提示 ── */}
      <p className="text-xs text-muted-foreground text-center pb-2">
        统计范围：仅 message 类型事件 · 数据实时写入，重启后仍保留 · 点击「同步群名」可从机器人拉取群名称
      </p>
    </div>
  )
}

// ─── 子组件 ──────────────────────────────────────────────────────────────────

function OverviewCard({
  icon,
  label,
  value,
  sub,
  color,
  bgColor,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  color: string
  bgColor: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className={cn("flex items-center gap-1.5 text-sm font-medium text-muted-foreground", color)}>
          <span className={cn("flex size-7 items-center justify-center rounded-lg", bgColor)}>
            {icon}
          </span>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}
