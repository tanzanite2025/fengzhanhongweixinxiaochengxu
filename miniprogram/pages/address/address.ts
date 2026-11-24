import { apiRequest } from '../../utils/request';
import type { AddressDto } from '../../utils/types';

Page({
  data: {
    selectMode: false,
    addresses: [] as AddressDto[],
    showForm: false,
    editingId: 0,
    receiverName: '',
    receiverPhone: '',
    province: '',
    city: '',
    district: '',
    regionValue: ['广东省', '深圳市', '南山区'] as [string, string, string],
    detailAddress: '',
    isDefault: false
  },

  onLoad(options: { select?: string }) {
    this.setData({ selectMode: options.select === '1' });
    this.loadAddresses();
  },

  async loadAddresses() {
    try {
      const addresses = await apiRequest<AddressDto[]>({ url: '/api/addresses' });
      this.setData({ addresses });
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '加载地址失败',
        icon: 'none'
      });
    }
  },

  onSelectAddress(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.selectMode) return;
    const id = e.currentTarget.dataset.id as number;
    const picked = this.data.addresses.find((a) => a.id === id);
    if (!picked) return;
    wx.setStorageSync('selected_checkout_address', picked);
    wx.navigateBack();
  },

  onImportWechatAddress() {
    wx.chooseAddress({
      success: async (res) => {
        try {
          const normalizedPhone = res.telNumber.replace(/[\s-]/g, '').replace(/^\+?86/, '');
          await apiRequest({
            url: '/api/addresses',
            method: 'POST',
            data: {
              receiverName: res.userName,
              receiverPhone: normalizedPhone,
              province: res.provinceName,
              city: res.cityName,
              district: res.countyName,
              detailAddress: res.detailInfo,
              isDefault: this.data.addresses.length === 0
            }
          });
          wx.showToast({ title: '已导入微信地址', icon: 'success' });
          await this.loadAddresses();
        } catch (err: unknown) {
          wx.showToast({
            title: err instanceof Error ? err.message : '保存微信地址失败',
            icon: 'none'
          });
        }
      },
      fail: (err) => {
        if (!err.errMsg.includes('cancel')) {
          wx.showToast({ title: `获取微信地址失败: ${err.errMsg}`, icon: 'none' });
        }
      }
    });
  },

  openAddForm() {
    this.setData({
      showForm: true,
      editingId: 0,
      receiverName: '',
      receiverPhone: '',
      province: '',
      city: '',
      district: '',
      regionValue: ['广东省', '深圳市', '南山区'] as [string, string, string],
      detailAddress: '',
      isDefault: this.data.addresses.length === 0
    });
  },

  openEditForm(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    const target = this.data.addresses.find((a) => a.id === id);
    if (!target) return;
    this.setData({
      showForm: true,
      editingId: target.id,
      receiverName: target.receiverName,
      receiverPhone: target.receiverPhone,
      province: target.province,
      city: target.city,
      district: target.district,
      regionValue: [target.province, target.city, target.district],
      detailAddress: target.detailAddress,
      isDefault: target.isDefault
    });
  },

  closeForm() {
    this.setData({ showForm: false });
  },

  onRegionChange(e: WechatMiniprogram.PickerChange) {
    const picked = e.detail.value as [string, string, string];
    this.setData({
      province: picked[0] ?? '',
      city: picked[1] ?? '',
      district: picked[2] ?? '',
      regionValue: picked
    });
  },

  onInputField(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as string;
    this.setData({ [field]: e.detail.value } as Record<string, string>);
  },

  onToggleDefault(e: WechatMiniprogram.SwitchChange) {
    this.setData({ isDefault: e.detail.value });
  },

  async onSaveAddress() {
    const {
      editingId,
      receiverName,
      receiverPhone,
      province,
      city,
      district,
      detailAddress,
      isDefault
    } = this.data;

    if (!receiverName.trim() || !receiverPhone.trim() || !province.trim() || !city.trim() || !district.trim() || !detailAddress.trim()) {
      wx.showToast({ title: '请完整填写收货信息并选择省市区', icon: 'none' });
      return;
    }

    try {
      if (editingId > 0) {
        await apiRequest({
          url: `/api/addresses/${editingId}`,
          method: 'PUT',
          data: {
            receiverName,
            receiverPhone,
            province,
            city,
            district,
            detailAddress,
            isDefault
          }
        });
      } else {
        await apiRequest({
          url: '/api/addresses',
          method: 'POST',
          data: {
            receiverName,
            receiverPhone,
            province,
            city,
            district,
            detailAddress,
            isDefault
          }
        });
      }
      this.setData({ showForm: false });
      await this.loadAddresses();
      wx.showToast({ title: '保存成功', icon: 'success' });
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '保存地址失败',
        icon: 'none'
      });
    }
  },

  async onDeleteAddress(e: WechatMiniprogram.TouchEvent) {
    const id = e.currentTarget.dataset.id as number;
    try {
      await apiRequest({ url: `/api/addresses/${id}`, method: 'DELETE' });
      await this.loadAddresses();
    } catch (err: unknown) {
      wx.showToast({
        title: err instanceof Error ? err.message : '删除失败',
        icon: 'none'
      });
    }
  }
});
