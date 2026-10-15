/**
 * CF 版 APK 的版本与身份事实来源。
 *
 * 与 Docker 客户端分开维护：两者是不同的 Android 应用，依赖不同宿主实现，
 * 包名必须不同才能同机共存；这条版本线描述 android/ 下的 WebView + 本地 bundle 壳。
 */
export const CF_VERSION = 'V2.22'
export const CF_VERSION_CODE = 420
export const CF_PACKAGE = 'com.yunmusic.cf'
export const CF_APP_NAME = '云音乐(CF版)'
