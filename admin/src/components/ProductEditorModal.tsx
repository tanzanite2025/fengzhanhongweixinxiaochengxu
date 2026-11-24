import { useState } from 'react';
import { adminFetch } from '../lib/api';
import type { Category, ProductSku, ShippingRule } from '../types';

export interface ProductFormState {
  id?: number;
  categoryId: number;
  shippingRuleId: number;
  title: string;
  subtitle: string;
  coverUrl: string;
  galleryUrls: string[];
  descriptionHtml: string;
  status: 'ON_SALE' | 'OFF_SALE';
  skus: Array<ProductSku & { priceYuan: string }>;
}

interface ProductEditorModalProps {
  initialState: ProductFormState;
  categories: Category[];
  shippingRules: ShippingRule[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function ProductEditorModal({
  initialState,
  categories,
  shippingRules,
  onClose,
  onSaved
}: ProductEditorModalProps) {
  const [form, setForm] = useState<ProductFormState>(initialState);
  const [newGalleryUrl, setNewGalleryUrl] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const uploadImageFile = async (file: File): Promise<string> => {
    const body = new FormData();
    body.append('file', file);
    const res = await adminFetch<{ url: string }>('/api/admin/upload', {
      method: 'POST',
      body
    });
    return res.url;
  };

  const handleUploadCover = async (file: File) => {
    setError('');
    try {
      const url = await uploadImageFile(file);
      setForm((prev) => ({ ...prev, coverUrl: url }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '封面图上传失败');
    }
  };

  const handleUploadGallery = async (file: File) => {
    setError('');
    try {
      const url = await uploadImageFile(file);
      setForm((prev) => ({ ...prev, galleryUrls: [...prev.galleryUrls, url] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '轮播图上传失败');
    }
  };

  const handleAddGalleryUrl = () => {
    const trimmed = newGalleryUrl.trim();
    if (!trimmed) return;
    setForm((prev) => ({ ...prev, galleryUrls: [...prev.galleryUrls, trimmed] }));
    setNewGalleryUrl('');
  };

  const handleRemoveGallery = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      galleryUrls: prev.galleryUrls.filter((_, i) => i !== idx)
    }));
  };

  const handleRemoveSku = (idx: number) => {
    if (form.skus.length <= 1) {
      setError('至少保留一个 SKU 规格');
      return;
    }
    setForm((prev) => ({
      ...prev,
      skus: prev.skus.filter((_, i) => i !== idx)
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const gallery = form.galleryUrls.length > 0 ? form.galleryUrls : [form.coverUrl];
      const payload = {
        categoryId: form.categoryId,
        shippingRuleId: form.shippingRuleId,
        title: form.title,
        subtitle: form.subtitle || null,
        coverUrl: form.coverUrl,
        galleryUrls: gallery,
        descriptionHtml: form.descriptionHtml,
        status: form.status,
        sortOrder: 100,
        skus: form.skus.map((s) => ({
          ...(s.id ? { id: s.id } : {}),
          skuCode: s.skuCode.trim(),
          specName: s.specName.trim(),
          priceCents: Math.round(Number(s.priceYuan) * 100),
          stock: Number(s.stock),
          isActive: s.isActive
        }))
      };

      if (form.id) {
        await adminFetch(`/api/admin/products/${form.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await adminFetch('/api/admin/products', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存商品失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-3xl rounded-[32px] bg-white p-8 shadow-2xl space-y-5 my-8 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-sm font-black">{form.id ? '编辑商品信息' : '新增实物商品'}</h2>

        {error && (
          <div className="rounded-2xl bg-rose-500/10 px-4 py-3 text-xs font-semibold text-rose-600">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="商品标题"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <input
            value={form.subtitle}
            onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
            placeholder="副标题卖点"
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          />
          <select
            value={form.categoryId}
            onChange={(e) => setForm({ ...form, categoryId: Number(e.target.value) })}
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                分类：{c.name}
              </option>
            ))}
          </select>
          <select
            value={form.shippingRuleId}
            onChange={(e) => setForm({ ...form, shippingRuleId: Number(e.target.value) })}
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          >
            {shippingRules.map((r) => (
              <option key={r.id} value={r.id}>
                运费：{r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={form.coverUrl}
            onChange={(e) => setForm({ ...form, coverUrl: e.target.value })}
            placeholder="封面主图 URL"
            className="flex-1 min-w-[220px] h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            required
          />
          <label className="rounded-full h-11 px-4 bg-slate-200 inline-flex items-center text-xs font-bold cursor-pointer">
            上传封面
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleUploadCover(f);
              }}
            />
          </label>
          <select
            value={form.status}
            onChange={(e) =>
              setForm({ ...form, status: e.target.value as 'ON_SALE' | 'OFF_SALE' })
            }
            className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
          >
            <option value="ON_SALE">上架销售</option>
            <option value="OFF_SALE">下架仓库</option>
          </select>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap justify-between items-center gap-2">
            <span className="text-xs font-bold text-slate-500">
              详情页轮播图（{form.galleryUrls.length} 张）
            </span>
            <label className="rounded-full h-9 px-4 bg-slate-100 inline-flex items-center text-xs font-bold cursor-pointer">
              + 上传轮播图
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUploadGallery(f);
                }}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <input
              value={newGalleryUrl}
              onChange={(e) => setNewGalleryUrl(e.target.value)}
              placeholder="或粘贴图片 URL 后点添加"
              className="flex-1 h-11 rounded-2xl border-none bg-slate-100 px-4 text-xs"
            />
            <button
              type="button"
              onClick={handleAddGalleryUrl}
              className="rounded-full h-11 px-4 bg-slate-200 text-xs font-bold cursor-pointer"
            >
              添加图片
            </button>
          </div>
          {form.galleryUrls.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {form.galleryUrls.map((url, idx) => (
                <div key={`${url}-${idx}`} className="relative group">
                  <img
                    src={url}
                    alt={`轮播图${idx + 1}`}
                    className="w-16 h-16 rounded-xl object-cover bg-slate-100"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveGallery(idx)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-rose-600 text-white text-xs leading-none cursor-pointer"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <span className="block text-xs font-bold text-slate-500">
            商品详情介绍（支持 HTML 标签或纯文本）
          </span>
          <textarea
            rows={4}
            value={form.descriptionHtml}
            onChange={(e) => setForm({ ...form, descriptionHtml: e.target.value })}
            placeholder="<p>输入商品材质、规格参数、售后保障说明</p>"
            className="w-full rounded-2xl border-none bg-slate-100 p-4 text-xs"
          />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold text-slate-500">SKU 规格配置</span>
            <button
              type="button"
              onClick={() =>
                setForm({
                  ...form,
                  skus: [
                    ...form.skus,
                    {
                      skuCode: `SKU-${Date.now()}-${form.skus.length}`,
                      specName: '新规格',
                      priceCents: 1000,
                      priceYuan: '10.00',
                      stock: 10,
                      isActive: true
                    }
                  ]
                })
              }
              className="text-xs font-bold text-slate-900 cursor-pointer"
            >
              + 添加规格行
            </button>
          </div>
          {form.skus.map((sku, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <input
                value={sku.skuCode}
                onChange={(e) => {
                  const next = [...form.skus];
                  next[idx] = { ...sku, skuCode: e.target.value };
                  setForm({ ...form, skus: next });
                }}
                placeholder="SKU编码"
                className="col-span-3 h-11 rounded-2xl border-none bg-slate-100 px-3 text-xs"
                required
              />
              <input
                value={sku.specName}
                onChange={(e) => {
                  const next = [...form.skus];
                  next[idx] = { ...sku, specName: e.target.value };
                  setForm({ ...form, skus: next });
                }}
                placeholder="规格名称"
                className="col-span-3 h-11 rounded-2xl border-none bg-slate-100 px-3 text-xs"
                required
              />
              <input
                type="number"
                step="0.01"
                value={sku.priceYuan}
                onChange={(e) => {
                  const next = [...form.skus];
                  next[idx] = { ...sku, priceYuan: e.target.value };
                  setForm({ ...form, skus: next });
                }}
                placeholder="售价(元)"
                className="col-span-2 h-11 rounded-2xl border-none bg-slate-100 px-3 text-xs"
                required
              />
              <input
                type="number"
                value={sku.stock}
                onChange={(e) => {
                  const next = [...form.skus];
                  next[idx] = { ...sku, stock: Number(e.target.value) };
                  setForm({ ...form, skus: next });
                }}
                placeholder="库存"
                className="col-span-2 h-11 rounded-2xl border-none bg-slate-100 px-3 text-xs"
                required
              />
              <label className="col-span-1 text-[11px] flex items-center justify-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sku.isActive}
                  onChange={(e) => {
                    const next = [...form.skus];
                    next[idx] = { ...sku, isActive: e.target.checked };
                    setForm({ ...form, skus: next });
                  }}
                />
                启用
              </label>
              <button
                type="button"
                onClick={() => handleRemoveSku(idx)}
                className="col-span-1 text-xs font-bold text-rose-600 cursor-pointer"
              >
                删
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full h-11 px-6 text-xs font-bold cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs disabled:opacity-50 cursor-pointer"
          >
            {saving ? '保存中...' : '保存商品'}
          </button>
        </div>
      </form>
    </div>
  );
}
