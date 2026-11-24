import { useEffect, useState } from 'react';
import { ProductEditorModal, type ProductFormState } from '../components/ProductEditorModal';
import { adminFetch, formatYuan } from '../lib/api';
import type { Category, Product, ShippingRule } from '../types';

export function ProductsPage({ canManageCategories }: { canManageCategories: boolean }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [shippingRules, setShippingRules] = useState<ShippingRule[]>([]);
  const [error, setError] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editing, setEditing] = useState<ProductFormState | null>(null);

  const loadAll = async () => {
    setError('');
    try {
      const catEndpoint = canManageCategories ? '/api/admin/categories' : '/api/categories';
      const [prods, cats, rules] = await Promise.all([
        adminFetch<Product[]>('/api/admin/products'),
        adminFetch<Category[]>(catEndpoint),
        adminFetch<ShippingRule[]>('/api/admin/shipping-rules')
      ]);
      setProducts(prods);
      setCategories(cats);
      setShippingRules(rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载商品数据失败');
    }
  };

  useEffect(() => {
    loadAll();
  }, [canManageCategories]);

  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) return;
    setError('');
    try {
      await adminFetch('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({ name: newCategoryName.trim(), sortOrder: 10, isActive: true })
      });
      setNewCategoryName('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建分类失败');
    }
  };

  const handleRenameCategory = async (cat: Category) => {
    const nextName = window.prompt('请输入新的分类名称', cat.name);
    if (!nextName || !nextName.trim() || nextName.trim() === cat.name) return;
    setError('');
    try {
      await adminFetch(`/api/admin/categories/${cat.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: nextName.trim(),
          sortOrder: cat.sortOrder,
          isActive: cat.isActive
        })
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新分类失败');
    }
  };

  const handleDeleteCategory = async (cat: Category) => {
    if (!window.confirm(`确认删除分类「${cat.name}」吗？`)) return;
    setError('');
    try {
      await adminFetch(`/api/admin/categories/${cat.id}`, { method: 'DELETE' });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除分类失败');
    }
  };

  const openCreateModal = () => {
    if (categories.length === 0 || shippingRules.length === 0) {
      setError('请先配置至少一个商品分类与运费模板');
      return;
    }
    const defaultCover = 'https://dummyimage.com/600x600/1e293b/f8fafc&text=Product';
    setEditing({
      categoryId: categories[0].id,
      shippingRuleId: shippingRules[0].id,
      title: '',
      subtitle: '',
      coverUrl: defaultCover,
      galleryUrls: [defaultCover],
      descriptionHtml: '<p>商品详情介绍</p>',
      status: 'ON_SALE',
      skus: [
        {
          skuCode: `SKU-${Date.now()}`,
          specName: '标准规格',
          priceCents: 9900,
          priceYuan: '99.00',
          stock: 100,
          isActive: true
        }
      ]
    });
  };

  const openEditModal = (p: Product) => {
    setEditing({
      id: p.id,
      categoryId: p.categoryId,
      shippingRuleId: p.shippingRuleId,
      title: p.title,
      subtitle: p.subtitle ?? '',
      coverUrl: p.coverUrl,
      galleryUrls: p.galleryUrls.length > 0 ? p.galleryUrls : [p.coverUrl],
      descriptionHtml: p.descriptionHtml,
      status: p.status,
      skus: p.skus.map((s) => ({
        ...s,
        priceYuan: formatYuan(s.priceCents)
      }))
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="rounded-[32px] border border-dashed border-slate-300 bg-slate-100/60 p-6 flex flex-wrap justify-between items-center gap-4">
        <div>
          <h1 className="text-lg font-black">商品与 SKU 管理</h1>
          <p className="text-xs font-semibold text-slate-500 mt-1">
            管理实物商品规格、轮播图文、售价、实时库存及上下架状态
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="rounded-full h-11 px-6 bg-slate-900 text-white font-bold text-xs cursor-pointer"
        >
          + 新增商品
        </button>
      </div>

      {error && (
        <div className="rounded-[24px] bg-rose-500/10 p-4 text-sm font-semibold text-rose-600">
          {error}
        </div>
      )}

      {canManageCategories && (
        <div className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 flex flex-wrap items-center gap-4">
          <h2 className="text-sm font-black mr-2">商品分类：</h2>
          <div className="flex flex-wrap gap-2 flex-1">
            {categories.map((c) => (
              <div
                key={c.id}
                className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 inline-flex items-center gap-2"
              >
                <span>{c.name}</span>
                <button
                  type="button"
                  onClick={() => handleRenameCategory(c)}
                  className="text-slate-500 hover:text-slate-900 cursor-pointer"
                >
                  改名
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteCategory(c)}
                  className="text-rose-500 hover:text-rose-700 cursor-pointer"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="新分类名称"
              className="h-12 rounded-2xl border-none bg-slate-100 px-4 text-sm"
            />
            <button
              onClick={handleAddCategory}
              className="rounded-full h-11 px-5 bg-slate-900 text-white font-bold text-xs cursor-pointer"
            >
              添加分类
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {products.map((p) => (
          <div
            key={p.id}
            className="rounded-[24px] border border-dashed border-slate-300 bg-white p-6 flex flex-wrap justify-between items-center gap-4"
          >
            <div className="flex items-center gap-4">
              <img
                src={p.coverUrl}
                alt={p.title}
                className="w-16 h-16 rounded-2xl object-cover bg-slate-100"
              />
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900">{p.title}</span>
                  <span
                    className={`rounded-full h-5 px-2.5 inline-flex items-center text-[11px] font-bold ${
                      p.status === 'ON_SALE'
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-amber-500/10 text-amber-600'
                    }`}
                  >
                    {p.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  分类：{p.category?.name ?? '-'} · 运费：{p.shippingRule?.name ?? '-'} · 销量：
                  {p.salesCount}
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {p.skus.map((s) => (
                    <span
                      key={s.skuCode}
                      className={`rounded-full bg-slate-100 px-3 py-1 text-xs font-medium tabular-nums ${
                        s.isActive ? '' : 'opacity-50 line-through'
                      }`}
                    >
                      {s.specName} | ¥{formatYuan(s.priceCents)} | 库存 {s.stock}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <button
              onClick={() => openEditModal(p)}
              className="rounded-full h-11 px-5 border border-slate-300 font-bold text-xs cursor-pointer"
            >
              编辑商品
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <ProductEditorModal
          initialState={editing}
          categories={categories}
          shippingRules={shippingRules}
          onClose={() => setEditing(null)}
          onSaved={loadAll}
        />
      )}
    </div>
  );
}
