import { useEffect, useState } from 'react';
import { adminFetch, formatYuan } from '../lib/api';
import type { ShippingRule } from '../types';

export function ShippingRulesPage() {
  const [rules, setRules] = useState<ShippingRule[]>([]);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [baseYuan, setBaseYuan] = useState('8.00');
  const [extraYuan, setExtraYuan] = useState('2.00');
  const [freeYuan, setFreeYuan] = useState('99.00');
  const [excludedText, setExcludedText] = useState('西藏,新疆');
  const [isDefault, setIsDefault] = useState(false);

  const loadRules = async () => {
    setError('');
    try {
      const list = await adminFetch<ShippingRule[]>('/api/admin/shipping-rules');
      setRules(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载运费模板失败');
    }
  };

  useEffect(() => {
    loadRules();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setBaseYuan('8.00');
    setExtraYuan('2.00');
    setFreeYuan('99.00');
    setExcludedText('西藏,新疆');
    setIsDefault(false);
  };

  const handleEditClick = (r: ShippingRule) => {
    setEditingId(r.id);
    setName(r.name);
    setBaseYuan(formatYuan(r.baseFeeCents));
    setExtraYuan(formatYuan(r.extraItemFeeCents));
    setFreeYuan(r.freeThresholdCents !== null ? formatYuan(r.freeThresholdCents) : '');
    setExcludedText(r.excludedProvinces.join(','));
    setIsDefault(r.isDefault);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const excluded = excludedText
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);

      const payload = {
        name: name.trim(),
        isDefault,
        baseFeeCents: Math.round(Number(baseYuan) * 100),
        extraItemFeeCents: Math.round(Number(extraYuan) * 100),
        freeThresholdCents: freeYuan.trim() ? Math.round(Number(freeYuan) * 100) : null,
        excludedProvinces: excluded
      };

      if (editingId !== null) {
        await adminFetch(`/api/admin/shipping-rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await adminFetch('/api/admin/shipping-rules', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      resetForm();
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存运费模板失败');
    }
  };

  const handleSetDefault = async (r: ShippingRule) => {
    setError('');
    try {
      await adminFetch(`/api/admin/shipping-rules/${r.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: r.name,
          isDefault: true,
          baseFeeCents: r.baseFeeCents,
          extraItemFeeCents: r.extraItemFeeCents,
          freeThresholdCents: r.freeThresholdCents,
          excludedProvinces: r.excludedProvinces
        })
      });
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置默认失败');
    }
  };

  const handleDelete = async (r: ShippingRule) => {
    if (!window.confirm(`确认删除运费模板「${r.name}」吗？`)) return;
    setError('');
    try {
      await adminFetch(`/api/admin/shipping-rules/${r.id}`, { method: 'DELETE' });
      if (editingId === r.id) {
        resetForm();
      }
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除运费模板失败');
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-[32px] border border-dashed border-slate-300 bg-slate-100/60 p-6">
        <h1 className="text-lg font-black">运费模板配置</h1>
        <p className="text-xs font-semibold text-slate-500 mt-1">
          配置首件运费、续件加价、满额包邮及偏远不发货地区
        </p>
      </div>

      {error && (
        <div className="rounded-[24px] bg-rose-500/10 p-4 text-sm font-semibold text-rose-600">
          {error}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 space-y-4"
      >
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-black">
            {editingId !== null ? `编辑运费模板 #${editingId}` : '新增运费模板'}
          </h2>
          {editingId !== null && (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs font-bold text-slate-500 cursor-pointer"
            >
              取消编辑
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-center">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="模板名称"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <input
            type="number"
            step="0.01"
            value={baseYuan}
            onChange={(e) => setBaseYuan(e.target.value)}
            placeholder="首件运费(元)"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <input
            type="number"
            step="0.01"
            value={extraYuan}
            onChange={(e) => setExtraYuan(e.target.value)}
            placeholder="续件加价(元)"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <input
            type="number"
            step="0.01"
            value={freeYuan}
            onChange={(e) => setFreeYuan(e.target.value)}
            placeholder="满多少包邮(空=不包邮)"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          />
          <input
            value={excludedText}
            onChange={(e) => setExcludedText(e.target.value)}
            placeholder="不发货省份(逗号分隔)"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          />
          <button
            type="submit"
            className="rounded-full h-11 bg-slate-900 text-white font-bold text-xs cursor-pointer"
          >
            {editingId !== null ? '保存修改' : '新增模板'}
          </button>
        </div>
      </form>

      <div className="grid grid-cols-1 gap-4">
        {rules.map((r) => (
          <div
            key={r.id}
            className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 flex flex-wrap justify-between items-center gap-4"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900">{r.name}</span>
                {r.isDefault && (
                  <span className="rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold bg-emerald-500/10 text-emerald-600">
                    DEFAULT
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1 tabular-nums">
                首件 ¥{formatYuan(r.baseFeeCents)} · 续件 ¥{formatYuan(r.extraItemFeeCents)} ·
                满额包邮：
                {r.freeThresholdCents !== null ? `¥${formatYuan(r.freeThresholdCents)}` : '不包邮'}
                · 不发货地区：
                {r.excludedProvinces.length > 0 ? r.excludedProvinces.join('、') : '全国发货'}
              </div>
            </div>
            <div className="flex gap-2">
              {!r.isDefault && (
                <button
                  onClick={() => handleSetDefault(r)}
                  className="rounded-full h-10 px-4 border border-slate-300 text-xs font-bold cursor-pointer"
                >
                  设为默认
                </button>
              )}
              <button
                onClick={() => handleEditClick(r)}
                className="rounded-full h-10 px-4 border border-slate-300 text-xs font-bold cursor-pointer"
              >
                编辑
              </button>
              <button
                onClick={() => handleDelete(r)}
                className="rounded-full h-10 px-4 border border-rose-200 text-xs font-bold text-rose-600 cursor-pointer"
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
