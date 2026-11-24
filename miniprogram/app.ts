import { ensureLogin } from './utils/request';

App({
  onLaunch() {
    ensureLogin().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : '登录初始化失败';
      wx.showToast({ title: msg, icon: 'none' });
    });
  }
});
