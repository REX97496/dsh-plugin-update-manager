/**
 * dsh-plugin-update-manager — client half.
 *
 * Single-file, build-free, no JSX. Only two modules may be required from the
 * host static module table: `react` and `@deepseek-ai/dsh-client-ui-primitives`.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-update-manager",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    var Button = primitives.Button;
    var Tag = primitives.Tag;
    var StateDot = primitives.StateDot;
    var Modal = primitives.Modal;
    var relativeTime = primitives.relativeTime;
    var writeClipboard = primitives.writeClipboard;

    var PACKAGE_ID = "dsh-plugin-update-manager";
    var NS = "plugin-updater";
    var API_PREFIX = "/plugin-updater/api";
    var UPDATABLE_STATUSES = { "update-latest": true, "update-compatible": true, "switch-compatible": true };
    /* Update-all summary is dismissed per operation id, across mount/unmount. */
    var lastDismissedUpdateAllId = null;

    /* Boot-time update toast: retry until the first check has finished. */
    var TOAST_RETRY_MS = 3000;
    var TOAST_MAX_ATTEMPTS = 30; /* 30 * 3s = 90s */
    var TOAST_MAX_ROWS = 3;
    var TOAST_MAX_DIAG = 3;
    var TOAST_NOTIFIED_PREFIX = "dsh-updater-notified:";
    var TOAST_SESSION_KEY = "dsh-updater-notified";

    var SOURCE_OPTIONS = [
      { id: "npm-official", labelKey: "sourceNpmOfficial" },
      { id: "npm-mirror", labelKey: "sourceNpmMirror" },
      { id: "github", labelKey: "sourceGithub" },
      { id: "github-mirror", labelKey: "sourceGithubMirror" }
    ];

    /* ------------------------------------------------------------------ */
    /* Dictionaries                                                        */
    /* ------------------------------------------------------------------ */

    var ZH = {
      nav: "插件更新",
      tab: "插件更新",
      title: "插件更新",
      intro: "查看本机已安装插件的版本状态，并在与本机 DSH 兼容的范围内更新；升级到最新版时会被版本闸拦截。",
      source: "更新源",
      sourceNpmOfficial: "npm 官方",
      sourceNpmMirror: "npm 国内镜像",
      sourceGithub: "GitHub",
      sourceGithubMirror: "GitHub 国内镜像",
      updateAll: "一键更新",
      oneClickUpdateHint: "更新全部 {n} 个有兼容版本的插件",
      checkNow: "立即检查",
      checking: "检查中…",
      lastChecked: "最后检查",
      neverChecked: "尚未检查",
      allowPrerelease: "允许预发布版本",
      interval: "检查间隔",
      hours: "小时",
      colPlugin: "插件",
      colInstalled: "已装",
      colStatus: "状态",
      colActions: "操作",
      loading: "正在读取插件状态…",
      empty: "没有可显示的插件",
      notReady: "更新服务未就绪",
      loadFailed: "读取插件状态失败",
      refreshFailed: "状态刷新失败，正在重试",
      retry: "重试",
      stale: "缓存",
      statusLatest: "最新",
      statusNewer: "有新版本",
      statusIncompatible: "不兼容",
      statusError: "检查失败",
      statusNotChecked: "未检查",
      statusLocal: "本地",
      statusBuiltin: "内置",
      viewReason: "查看原因",
      unmetHeadName: "依赖",
      unmetHeadRange: "要求",
      unmetHeadActual: "实际",
      reasonEmpty: "未提供未满足项信息",
      updateTo: "更新到 {version}",
      updateToCompatible: "更新到兼容版 {version}",
      switchToCompatible: "切换到兼容版 {version}",
      updateLatestOption: "更新到最新版 {version}",
      latestRisk: "可能与本机 DSH 不兼容，会被版本闸跳过",
      switchNote: "当前版本 {current} 与本机 DSH 不兼容，将切换为兼容版本 {target}（可能降级）。",
      confirmUpdate: "确认更新",
      confirmSwitch: "确认切换",
      cancel: "取消",
      updating: "更新中…",
      queued: "排队中",
      cancelUpdate: "取消",
      pendingRestart: "需重启生效",
      restartDsh: "重启 DSH",
      restartTitle: "需要重启 DSH",
      restartGuide: "请完全退出 DSH 桌面版（含系统托盘图标），再重新打开，新版本才会生效。",
      restartFailed: "重启请求失败",
      updateFailed: "更新失败",
      viewDetails: "查看详情",
      failTitle: "更新失败详情",
      close: "关闭",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败，请手动选中文本后复制。",
      detailPackage: "插件",
      detailFrom: "原版本",
      detailTo: "目标版本",
      detailAt: "时间",
      detailMessage: "信息",
      detailOutput: "输出（pnpm）：",
      cliHintTitle: "如果提示文件被占用，可完全退出 DSH（含托盘）后，在终端运行：",
      cliHintCopy: "复制命令",
      copyLog: "复制日志",
      githubRiskNote: "GitHub 源将从 release 资产（.tgz）安装；没有发布资产的版本会被拒绝（需要构建）。可改用 npm 国内镜像更新。",
      relNow: "刚刚",
      relMinutes: "{n} 分钟前",
      relHours: "{n} 小时前",
      relDays: "{n} 天前",
      relMonths: "{n} 个月前",
      relYears: "{n} 年前",
      configFailed: "保存设置失败",
      checkFailed: "检查请求失败",
      updateRequestFailed: "更新请求失败",
      updateAllSucceeded: "已更新 {n} 个插件，重启 DSH 后生效",
      updateAllPartial: "{ok} 个成功，{failed} 个失败",
      viewReport: "查看报告",
      updateAllReportTitle: "全部更新报告",
      updateAllNoItems: "没有可显示的条目",
      updateAllFailLine: " — 更新失败：{message}",
      toastCount: "{n} 个插件有兼容更新",
      toastCurrent: "当前 {from} → {to}",
      toastMore: "等 {n} 个",
      toastHint: "点击查看并升级",
      toastClose: "关闭提醒",
      diagnosticsBanner: "启动诊断：{n} 个插件加载异常",
      diagnosticsButton: "诊断",
      diagnosticsView: "查看分析",
      diagnosticsRerun: "重新诊断",
      diagnosticsScanning: "诊断中…",
      diagnosticsTitle: "启动诊断",
      diagnosticsEmpty: "未发现插件加载异常",
      diagnosticsDetail: "查看详情",
      diagnosticsCollapse: "收起详情",
      diagnosticsCopyCommand: "复制命令",
      diagnosticsCopied: "已复制",
      diagnosticsUpdateTo: "更新到 {version}",
      diagnosticsUpdating: "更新中…",
      diagnosticsUpdateQueued: "已提交更新，完成后重启 DSH 生效",
      diagnosticsFixHint: "先切换到插件目录，再执行命令：",
      diagnosticsToastLine: "查看全部 {n} 项分析",
      diagnosticsToastTitle: "{n} 个插件加载异常",
      diagnosticsMetaItems: "共 {n} 项",
      diagnosticsMetaFiles: "扫描 {n} 个日志",
      diagnosticsMetaTime: "检查于 {time}",
      diagnosticsSeverityError: "错误",
      diagnosticsSeverityWarn: "警告",
      toastDiagMore: "还有 {n} 条异常",
      diagnosticsFailed: "诊断失败，请稍后重试",
      diagnosticsUnknownPlugin: "(未知插件)",
      diagnosticsNoFix: "暂无自动修复建议，请查看详情",
      moreActions: "更多操作",
      moreActionsBusy: "该插件有进行中的操作",
      moreActionsUnmanaged: "仅可对 registry 插件执行此操作",
      moreActionsSelf: "不能操作本插件自身",
      reinstall: "重新安装",
      uninstall: "卸载",
      uninstallConfirmTitle: "卸载插件",
      uninstallConfirmBody: "将把该插件从 profile 的 dependencies 与 dsh.profile.bundles 中移除，并删除 node_modules 下的安装；需要重启 DSH 后生效。",
      uninstallConfirmAction: "卸载",
      reinstalling: "重新安装中…",
      uninstalling: "卸载中…",
      loadFailedBadge: "加载失败",
      loadFailureDetails: "查看加载失败原因"
    };

    var EN = {
      nav: "Plugin updates",
      tab: "Plugin updates",
      title: "Plugin updates",
      intro: "Check installed plugin versions and update them within the range compatible with this DSH build. Upgrading to the latest version is blocked by the version gate.",
      source: "Update source",
      sourceNpmOfficial: "npm (official)",
      sourceNpmMirror: "npm (China mirror)",
      sourceGithub: "GitHub",
      sourceGithubMirror: "GitHub (China mirror)",
      updateAll: "Update all",
      oneClickUpdateHint: "Update all {n} plugin(s) with a compatible version",
      checkNow: "Check now",
      checking: "Checking…",
      lastChecked: "Last checked",
      neverChecked: "Never checked",
      allowPrerelease: "Allow pre-release versions",
      interval: "Check interval",
      hours: "hours",
      colPlugin: "Plugin",
      colInstalled: "Installed",
      colStatus: "Status",
      colActions: "Actions",
      loading: "Loading plugin state…",
      empty: "No plugins to show",
      notReady: "Update service is not ready",
      loadFailed: "Failed to load plugin state",
      refreshFailed: "Refreshing state failed, retrying",
      retry: "Retry",
      stale: "cached",
      statusLatest: "Up to date",
      statusNewer: "Update available",
      statusIncompatible: "Incompatible",
      statusError: "Check failed",
      statusNotChecked: "Not checked",
      statusLocal: "Local",
      statusBuiltin: "Built-in",
      viewReason: "View reason",
      unmetHeadName: "Dependency",
      unmetHeadRange: "Required",
      unmetHeadActual: "Actual",
      reasonEmpty: "No unmet requirement details",
      updateTo: "Update to {version}",
      updateToCompatible: "Update to compatible {version}",
      switchToCompatible: "Switch to compatible {version}",
      updateLatestOption: "Update to latest {version}",
      latestRisk: "May be incompatible with this DSH build and will be skipped by the version gate",
      switchNote: "Current version {current} is incompatible with this DSH build; switching to compatible version {target} (may downgrade).",
      confirmUpdate: "Confirm update",
      confirmSwitch: "Confirm switch",
      cancel: "Cancel",
      updating: "Updating…",
      queued: "Queued",
      cancelUpdate: "Cancel",
      pendingRestart: "Restart required",
      restartDsh: "Restart DSH",
      restartTitle: "Restart required",
      restartGuide: "Fully quit the DSH desktop app (including the tray icon) and open it again so the new version takes effect.",
      restartFailed: "Restart request failed",
      updateFailed: "Update failed",
      viewDetails: "Details",
      failTitle: "Update failure details",
      close: "Close",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed; please select the text and copy it manually.",
      detailPackage: "Plugin",
      detailFrom: "From",
      detailTo: "To",
      detailAt: "At",
      detailMessage: "Message",
      detailOutput: "Output (pnpm):",
      cliHintTitle: "If a file is reported as in use, fully quit DSH (including the tray icon) and run this in a terminal:",
      cliHintCopy: "Copy command",
      copyLog: "Copy log",
      githubRiskNote: "GitHub source installs from release assets (.tgz); versions without assets are rejected (they need a build). Switch to the npm mirror source to update.",
      relNow: "just now",
      relMinutes: "{n} min ago",
      relHours: "{n} h ago",
      relDays: "{n} d ago",
      relMonths: "{n} mo ago",
      relYears: "{n} y ago",
      configFailed: "Failed to save settings",
      checkFailed: "Check request failed",
      updateRequestFailed: "Update request failed",
      updateAllSucceeded: "Updated {n} plugin(s). Restart DSH to apply.",
      updateAllPartial: "{ok} succeeded, {failed} failed",
      viewReport: "View report",
      updateAllReportTitle: "Update-all report",
      updateAllNoItems: "No items to show",
      updateAllFailLine: " — failed: {message}",
      toastCount: "{n} plugin(s) have compatible updates",
      toastCurrent: "current {from} → {to}",
      toastMore: "{n} in total",
      toastHint: "Click to review and update",
      toastClose: "Dismiss reminder",
      diagnosticsBanner: "Startup diagnostics: {n} plugin(s) failed to load",
      diagnosticsButton: "Diagnose",
      diagnosticsView: "View analysis",
      diagnosticsRerun: "Run diagnostics again",
      diagnosticsScanning: "Diagnosing…",
      diagnosticsTitle: "Startup diagnostics",
      diagnosticsEmpty: "No plugin load issues found",
      diagnosticsDetail: "Show details",
      diagnosticsCollapse: "Hide details",
      diagnosticsCopyCommand: "Copy command",
      diagnosticsCopied: "Copied",
      diagnosticsUpdateTo: "Update to {version}",
      diagnosticsUpdating: "Updating…",
      diagnosticsUpdateQueued: "Update submitted. Restart DSH to apply.",
      diagnosticsFixHint: "Change to the plugin directory first, then run:",
      diagnosticsToastLine: "View all {n} finding(s)",
      diagnosticsToastTitle: "{n} plugin(s) failed to load",
      diagnosticsMetaItems: "{n} finding(s)",
      diagnosticsMetaFiles: "{n} log file(s) scanned",
      diagnosticsMetaTime: "checked at {time}",
      diagnosticsSeverityError: "error",
      diagnosticsSeverityWarn: "warning",
      toastDiagMore: "{n} more finding(s)",
      diagnosticsFailed: "Diagnostics failed, please try again",
      diagnosticsUnknownPlugin: "(Unknown plugin)",
      diagnosticsNoFix: "No automatic fix available. Check the details.",
      moreActions: "More actions",
      moreActionsBusy: "An operation is in progress for this plugin",
      moreActionsUnmanaged: "Only registry plugins can be managed",
      moreActionsSelf: "This plugin cannot operate on itself",
      reinstall: "Reinstall",
      uninstall: "Uninstall",
      uninstallConfirmTitle: "Uninstall plugin",
      uninstallConfirmBody: "Removes the plugin from the profile dependencies and dsh.profile.bundles, and deletes its node_modules entry. Restart DSH to apply.",
      uninstallConfirmAction: "Uninstall",
      reinstalling: "Reinstalling…",
      uninstalling: "Uninstalling…",
      loadFailedBadge: "Failed to load",
      loadFailureDetails: "View load failure details"
    };

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    /**
     * Translator with a built-in fallback: when the host translator is absent
     * or returns the key itself (unregistered dictionary), the bundled zh/en
     * strings are used. `{name}` placeholders are interpolated locally so the
     * result is identical whether or not the host locale does interpolation.
     */
    function makeTranslator(t) {
      return function translate(key, params) {
        var value;
        if (typeof t === "function") {
          try {
            value = t(key, params);
          } catch (error) {
            value = undefined;
          }
        }
        if (value === undefined || value === null || value === "" || value === key) {
          value = hasOwn(ZH, key) ? ZH[key] : hasOwn(EN, key) ? EN[key] : undefined;
        }
        if (value === undefined || value === null) value = key;
        if (params && typeof value === "string" && value.indexOf("{") !== -1) {
          value = value.replace(/\{(\w+)\}/g, function (match, name) {
            return params[name] === undefined ? match : String(params[name]);
          });
        }
        return String(value);
      };
    }

    /** relativeTime primitive returns {unit,n}; compose the localized string. */
    function formatRelative(at, now, tr) {
      if (at === undefined || at === null || at === "") return "";
      var timestamp = typeof at === "number" ? at : Date.parse(at);
      if (!isFinite(timestamp)) return "";
      var info;
      try {
        info = typeof relativeTime === "function" ? relativeTime(timestamp, now) : null;
      } catch (error) {
        info = null;
      }
      if (typeof info === "string") return info;
      if (!info || typeof info !== "object") return "";
      var n = typeof info.n === "number" && isFinite(info.n) ? info.n : 0;
      switch (info.unit) {
        case "now":
          return tr("relNow");
        case "minutes":
          return tr("relMinutes", { n: n });
        case "hours":
          return tr("relHours", { n: n });
        case "days":
          return tr("relDays", { n: n });
        case "months":
          return tr("relMonths", { n: n });
        case "years":
          return tr("relYears", { n: n });
        default:
          return "";
      }
    }

    function iconNode(name, props) {
      var Comp = primitives[name];
      if (typeof Comp !== "function") return null;
      var merged = { "aria-hidden": "true" };
      if (props) {
        for (var key in props) {
          if (hasOwn(props, key)) merged[key] = props[key];
        }
      }
      return h(Comp, merged);
    }

    function apiError(message, code, status) {
      var error = new Error(message || code || "request-failed");
      error.code = code;
      error.status = status;
      return error;
    }

    async function readEnvelope(response) {
      var payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (payload && typeof payload === "object" && typeof payload.ok === "boolean") {
        if (payload.ok) return payload.value;
        var detail = payload.error && typeof payload.error === "object" ? payload.error : {};
        var failure = apiError(typeof detail.message === "string" ? detail.message : "", typeof detail.code === "string" ? detail.code : "error", response && response.status);
        if (typeof detail.detail === "string" && detail.detail) failure.detail = detail.detail;
        throw failure;
      }
      var status = response && typeof response.status === "number" ? response.status : 0;
      if (status === 404) throw apiError("", "not-ready", 404);
      throw apiError("", "bad-response", status);
    }

    async function fetchState(signal) {
      if (typeof fetch !== "function") throw apiError("", "no-fetch", 0);
      var response = await fetch(API_PREFIX + "/state", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: signal || undefined
      });
      return readEnvelope(response);
    }

    async function postJson(path, body, signal) {
      if (typeof fetch !== "function") throw apiError("", "no-fetch", 0);
      var init = {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: signal || undefined
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      var response = await fetch(API_PREFIX + path, init);
      return readEnvelope(response);
    }

    function isAbortError(error) {
      return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
    }

    function errorMessage(error, tr, fallbackKey) {
      if (!error) return tr(fallbackKey);
      if (error.code === "not-ready" || error.code === "no-fetch") return tr("notReady");
      if (typeof error.message === "string" && error.message) return error.message;
      return tr(fallbackKey);
    }

    function isBusyState(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return false;
      if (snapshot.checking === true) return true;
      if (snapshot.activeOperationId) return true;
      var operations = Array.isArray(snapshot.operations) ? snapshot.operations : [];
      for (var index = 0; index < operations.length; index += 1) {
        var operation = operations[index];
        if (operation && (operation.state === "running" || operation.state === "queued")) return true;
      }
      return false;
    }

    function isUpdatableRow(row) {
      return Boolean(row) && UPDATABLE_STATUSES[row.status] === true;
    }

    function sourceLabel(sourceId, tr) {
      switch (sourceId) {
        case "npm-official":
          return tr("sourceNpmOfficial");
        case "npm-mirror":
          return tr("sourceNpmMirror");
        case "github":
          return tr("sourceGithub");
        case "github-mirror":
          return tr("sourceGithubMirror");
        default:
          return typeof sourceId === "string" ? sourceId : "";
      }
    }

    function buildSources(snapshot, tr) {
      var list = snapshot && Array.isArray(snapshot.sources) ? snapshot.sources : null;
      if (list && list.length > 0) {
        var options = [];
        for (var index = 0; index < list.length; index += 1) {
          var item = list[index];
          if (!item || typeof item.id !== "string" || !item.id) continue;
          options.push({
            id: item.id,
            label: typeof item.label === "string" && item.label ? item.label : sourceLabel(item.id, tr)
          });
        }
        if (options.length > 0) return options;
      }
      var fallback = [];
      for (var sourceIndex = 0; sourceIndex < SOURCE_OPTIONS.length; sourceIndex += 1) {
        var source = SOURCE_OPTIONS[sourceIndex];
        fallback.push({ id: source.id, label: tr(source.labelKey) });
      }
      return fallback;
    }

    /** Version the row's primary action targets (contract target first). */
    function targetVersion(row) {
      if (!row) return "";
      var target = row.target && typeof row.target === "object" ? row.target : null;
      if (target && typeof target.version === "string" && target.version) return target.version;
      if (typeof row.compatibleMax === "string" && row.compatibleMax) return row.compatibleMax;
      if (typeof row.latestVersion === "string" && row.latestVersion) return row.latestVersion;
      return typeof row.installedVersion === "string" ? row.installedVersion : "";
    }

    function findQueuedOperation(snapshot, name) {
      var operations = snapshot && Array.isArray(snapshot.operations) ? snapshot.operations : [];
      for (var index = 0; index < operations.length; index += 1) {
        var operation = operations[index];
        if (!operation || operation.state !== "queued") continue;
        if (operation.name === name) return operation;
        if (Array.isArray(operation.names) && operation.names.indexOf(name) !== -1) return operation;
      }
      return null;
    }

    function operationOfRow(row) {
      return row && row.operation && typeof row.operation === "object" ? row.operation : null;
    }

    function operationIdOf(row, snapshot) {
      var operation = operationOfRow(row);
      if (operation) {
        if (typeof operation.id === "string" && operation.id) return operation.id;
        if (typeof operation.operationId === "string" && operation.operationId) return operation.operationId;
      }
      if (snapshot && typeof snapshot.activeOperationId === "string" && snapshot.activeOperationId) return snapshot.activeOperationId;
      return "";
    }

    function operationMessage(operation) {
      if (!operation) return "";
      if (typeof operation.message === "string" && operation.message) return operation.message;
      var progress = operation.progress;
      if (progress && typeof progress === "object" && typeof progress.message === "string") return progress.message;
      if (typeof progress === "string" && progress) return progress;
      return "";
    }

    function toTimestamp(value) {
      if (typeof value === "number" && isFinite(value)) return value;
      if (typeof value === "string" && value) {
        var parsed = Date.parse(value);
        if (!isNaN(parsed)) return parsed;
      }
      return 0;
    }

    /**
     * Latest finished `update-all` operation that carries a `result` report.
     * Older host versions have neither, so a missing result renders nothing.
     */
    function latestUpdateAllOperation(snapshot) {
      var operations = snapshot && Array.isArray(snapshot.operations) ? snapshot.operations : [];
      var latest = null;
      for (var index = 0; index < operations.length; index += 1) {
        var operation = operations[index];
        if (!operation || operation.kind !== "update-all") continue;
        if (operation.state !== "succeeded" && operation.state !== "failed") continue;
        if (!operation.result || typeof operation.result !== "object") continue;
        if (latest === null) {
          latest = operation;
          continue;
        }
        var currentAt = toTimestamp(operation.endedAt) || toTimestamp(operation.startedAt);
        var latestAt = toTimestamp(latest.endedAt) || toTimestamp(latest.startedAt);
        if (currentAt >= latestAt) latest = operation;
      }
      return latest;
    }

    function updateAllCounts(result) {
      var items = result && Array.isArray(result.items) ? result.items : [];
      var succeeded = result && typeof result.succeeded === "number" && isFinite(result.succeeded) ? result.succeeded : null;
      var failed = result && typeof result.failed === "number" && isFinite(result.failed) ? result.failed : null;
      var okItems = 0;
      var failItems = 0;
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        if (!item || typeof item !== "object") continue;
        if (item.ok === false) failItems += 1;
        else okItems += 1;
      }
      return {
        succeeded: succeeded === null ? okItems : succeeded,
        failed: failed === null ? failItems : failed,
        items: items
      };
    }

    function updateAllSummaryKey(operation) {
      if (operation && typeof operation.id === "string" && operation.id) return operation.id;
      return "update-all@" + String(toTimestamp(operation && operation.endedAt) || toTimestamp(operation && operation.startedAt));
    }

    /* ------------------------------------------------------------------ */
    /* Boot toast helpers                                                  */
    /* ------------------------------------------------------------------ */

    /** Session/localStorage access that never throws (private mode, SSR). */
    function storageFor(kind) {
      try {
        if (typeof window === "undefined" || !window) return null;
        return kind === "local" ? window.localStorage : window.sessionStorage;
      } catch (error) {
        return null;
      }
    }

    function readFlag(kind, key) {
      var storage = storageFor(kind);
      if (!storage) return false;
      try {
        return storage.getItem(key) === "1";
      } catch (error) {
        return false;
      }
    }

    function writeFlag(kind, key) {
      var storage = storageFor(kind);
      if (!storage) return false;
      try {
        storage.setItem(key, "1");
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * "Already shown in this boot?" — keyed by the host-provided boot id so a
     * page reload does not pop the toast again. When the host does not expose
     * bootId (older builds, harness fixtures) fall back to a session marker.
     */
    function toastNotified(bootId) {
      if (typeof bootId === "string" && bootId) return readFlag("local", TOAST_NOTIFIED_PREFIX + bootId);
      return readFlag("session", TOAST_SESSION_KEY);
    }

    function markToastNotified(bootId) {
      writeFlag("session", TOAST_SESSION_KEY);
      if (typeof bootId === "string" && bootId) writeFlag("local", TOAST_NOTIFIED_PREFIX + bootId);
    }

    /** Rows that have a real compatible upgrade target to offer. */
    function updatableRowsOf(snapshot) {
      var rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
      var result = [];
      for (var index = 0; index < rows.length; index += 1) {
        var row = rows[index];
        if (!row || typeof row !== "object") continue;
        if (UPDATABLE_STATUSES[row.status] !== true) continue;
        var version = targetVersion(row);
        if (!version) continue;
        if (typeof row.installedVersion === "string" && row.installedVersion === version) continue;
        result.push(row);
      }
      return result;
    }

    function hasCheckedOnce(snapshot) {
      return Boolean(snapshot && snapshot.lastCheckAt);
    }

    /* ------------------------------------------------------------------ */
    /* Startup diagnostics                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * The host exposes `state.diagnostics` only after its first startup scan
     * completed (null before that, undefined on older hosts). Return the value
     * only when it is structurally usable so every caller can bail out safely.
     */
    function diagnosticsOf(snapshot) {
      var value = snapshot && typeof snapshot === "object" ? snapshot.diagnostics : null;
      if (!value || typeof value !== "object" || !Array.isArray(value.items)) return null;
      return value;
    }

    function diagnosticItems(snapshot) {
      var diagnostics = diagnosticsOf(snapshot);
      return diagnostics ? sortDiagnosticItems(diagnostics.items) : [];
    }

    /**
     * Errors first, warnings after; the entries of one plugin stay together
     * and are ordered newest first so the most recent failure reads first.
     */
    function sortDiagnosticItems(items) {
      var copy = items.slice();
      copy.sort(function (left, right) {
        var rankLeft = left && left.severity === "error" ? 0 : 1;
        var rankRight = right && right.severity === "error" ? 0 : 1;
        if (rankLeft !== rankRight) return rankLeft - rankRight;
        var pluginLeft = left && typeof left.plugin === "string" ? left.plugin : "";
        var pluginRight = right && typeof right.plugin === "string" ? right.plugin : "";
        if (pluginLeft !== pluginRight) return pluginLeft < pluginRight ? -1 : 1;
        return toTimestamp(right && right.at) - toTimestamp(left && left.at);
      });
      return copy;
    }

    /** Number of distinct plugins behind a set of diagnostic items. */
    function diagnosticPluginCount(items) {
      var seen = {};
      var count = 0;
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        var plugin = item && typeof item.plugin === "string" ? item.plugin : "";
        if (!plugin || seen[plugin] === true) continue;
        seen[plugin] = true;
        count += 1;
      }
      return count;
    }

    function diagnosticErrorItems(snapshot) {
      var items = diagnosticItems(snapshot);
      var result = [];
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        if (item && typeof item === "object" && item.severity === "error") result.push(item);
      }
      return result;
    }

    /**
     * Diagnostics limited to one plugin. When the cached diagnostics items are
     * empty (scan not finished this boot) fall back to the row's `loadFailure`
     * entry so the badge always has something to show.
     */
    function diagnosticItemsFor(snapshot, plugin) {
      var all = diagnosticItems(snapshot);
      if (typeof plugin !== "string" || !plugin) return all;
      var result = [];
      for (var index = 0; index < all.length; index += 1) {
        var item = all[index];
        if (item && item.plugin === plugin) result.push(item);
      }
      if (result.length > 0) return result;
      var rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        var row = rows[rowIndex];
        if (!row || row.name !== plugin) continue;
        var failure = row.loadFailure && typeof row.loadFailure === "object" ? row.loadFailure : null;
        if (!failure) continue;
        result.push({
          id: plugin + "@load-failure",
          plugin: plugin,
          code: typeof failure.code === "string" ? failure.code : "unknown",
          severity: "error",
          title: typeof failure.title === "string" ? failure.title : "",
          summary: typeof failure.summary === "string" ? failure.summary : "",
          detail: typeof failure.detail === "string" ? failure.detail : "",
          at: failure.at,
          fixes: Array.isArray(failure.fixes) ? failure.fixes : []
        });
        break;
      }
      return result;
    }

    function diagnosticFixes(item) {
      return item && Array.isArray(item.fixes) ? item.fixes : [];
    }

    /** Copy helper that prefers the host clipboard primitive. */
    function copyTextToClipboard(text) {
      var value = typeof text === "string" ? text : String(text == null ? "" : text);
      if (typeof writeClipboard === "function") {
        return Promise.resolve(writeClipboard(value)).then(function (ok) {
          return ok !== false;
        }, function () {
          return fallbackClipboard(value);
        });
      }
      return fallbackClipboard(value);
    }

    function fallbackClipboard(value) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          return navigator.clipboard.writeText(value).then(function () {
            return true;
          }, function () {
            return false;
          });
        }
      } catch (error) {
        return Promise.resolve(false);
      }
      return Promise.resolve(false);
    }

    function diagnosticFixKey(item, index) {
      return String(item && item.id != null ? item.id : "item-" + index);
    }

    function diagnosticTimeText(at, tr, now) {
      var timestamp = toTimestamp(at);
      var moment = typeof now === "number" ? now : Date.now();
      if (!timestamp) return "";
      return formatRelative(timestamp, moment, tr);
    }

    /** Local wall-clock time (HH:MM:SS) for one diagnostic entry. */
    function diagnosticClockText(at) {
      var timestamp = toTimestamp(at);
      if (!timestamp) return "";
      var date = new Date(timestamp);
      function pad(value) { return value < 10 ? "0" + value : String(value); }
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /**
     * First lines of a diagnostic detail so a collapsed entry already shows the
     * real failure line instead of only the one-sentence summary.
     */
    function diagnosticPreview(detail, maxLines, maxChars) {
      if (typeof detail !== "string" || detail === "") return "";
      var lines = detail.split(/\r?\n/);
      var picked = [];
      for (var index = 0; index < lines.length && picked.length < maxLines; index += 1) {
        var line = lines[index].replace(/\s+$/, "");
        if (line === "") continue;
        picked.push(line);
      }
      var text = picked.join("\n");
      var limit = typeof maxChars === "number" && maxChars > 0 ? maxChars : 240;
      if (text.length > limit) text = text.slice(0, limit - 1) + "\u2026";
      return text;
    }

    /** "N findings - M log files - checked at HH:MM:SS" for the dialog header. */
    function diagnosticMetaText(diagnostics, total, tr) {
      var parts = [];
      if (typeof total === "number" && total > 0) parts.push(tr("diagnosticsMetaItems", { n: String(total) }));
      var scanned = diagnostics && Array.isArray(diagnostics.scanned) ? diagnostics.scanned.length : 0;
      if (scanned > 0) parts.push(tr("diagnosticsMetaFiles", { n: String(scanned) }));
      var clock = diagnostics ? diagnosticClockText(diagnostics.checkedAt) : "";
      if (clock) parts.push(tr("diagnosticsMetaTime", { time: clock }));
      return parts.join(" \u00b7 ");
    }

    /* ------------------------------------------------------------------ */
    /* Styles (host tokens only; no literal colors or font families)       */
    /* ------------------------------------------------------------------ */

    var CSS = `
.updater{max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}
.updater *{box-sizing:border-box}
.updaterHead{display:flex;flex-direction:column;gap:4px}
.heading{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:28px}
.toolLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.select{height:28px;max-width:220px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.select:hover{background:var(--dsw-alias-interactive-bg-hover)}
.select:disabled{opacity:.4;cursor:not-allowed}
.toolbarSpacer{flex:1 1 auto}
.lastChecked{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.settings{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.checkbox{margin:0;width:14px;height:14px;accent-color:var(--dsw-alias-label-primary);cursor:pointer}
.number{height:28px;width:64px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;text-align:right}
.number:disabled,.checkbox:disabled{opacity:.4;cursor:not-allowed}
.select:focus-visible,.number:focus-visible,.checkbox:focus-visible,.linkBtn:focus-visible,.radio:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.notice{display:flex;align-items:center;gap:8px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.noticeText{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.noticeError{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-secondary)))}
.summary{display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.summaryText{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.table{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.row{display:grid;grid-template-columns:minmax(0,1fr) 72px 76px 180px;align-items:center;column-gap:12px;min-height:44px;padding:0 12px}
.head{min-height:44px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.headActions{text-align:right}
.bodyRows{display:flex;flex-direction:column}
.rowBlock{border-top:.5px solid var(--dsw-alias-border-l2)}
.rowBlock:hover>.row{background:var(--dsw-alias-interactive-bg-hover)}
.nameCell{display:flex;flex-direction:column;justify-content:center;gap:1px;min-width:0;padding:2px 0}
.nameLine{display:flex;align-items:center;gap:6px;min-width:0}
.name{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.bundle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit))}
.kindLabel{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.versionCell{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:1px}
.statusCell{min-width:0;display:flex;align-items:center}
.version{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.versionNext{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.status{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.statusText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.muted{color:var(--dsw-alias-label-tertiary)}
.hint{flex:none;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}
.actionsPlaceholder{display:block;height:28px;min-width:1px}
.actionText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.actionTextDanger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-secondary)))}
.detailWrap{padding:0 12px 10px}
.detail{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.panel{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.options{display:flex;flex-direction:column;gap:6px}
.option{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}
.radio{margin:2px 0 0;accent-color:var(--dsw-alias-label-primary);cursor:pointer}
.optionText{display:flex;flex-direction:column;gap:1px;min-width:0}
.optionRisk{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.panelNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.panelFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.unmet,.unmetHead{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr);gap:2px 12px;font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit));font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.unmetHead{color:var(--dsw-alias-label-tertiary)}
.linkBtn{align-self:flex-start;margin:0;padding:0;border:0;background:0 0;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.linkBtn:hover{color:var(--dsw-alias-label-primary)}
.emptyRow{padding:24px 12px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.loadingRows{display:flex;flex-direction:column}
.skeletonRow{min-height:44px}
.skeleton{display:block;height:12px;width:60%;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-interactive-bg-hover))}
@media (prefers-reduced-motion:no-preference){.skeleton{animation:updater-pulse 1.6s ease-in-out infinite}}
@keyframes updater-pulse{0%,100%{opacity:.6}50%{opacity:1}}
.modalBody{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.modalText{margin:0;overflow-wrap:anywhere}
.modalFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.copiedNote{margin-right:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.code{margin:0;max-height:220px;overflow:auto;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit));font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
.cliHint{display:flex;flex-direction:column;gap:6px;margin:2px 0 0}
.cliHintText{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.cliRow{display:flex;align-items:center;gap:8px;min-width:0}
.cliCommand{flex:1 1 auto;min-width:0;overflow-x:auto;white-space:nowrap;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-interactive-bg-hover));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);user-select:text}
.toast{position:fixed;right:20px;bottom:20px;z-index:2147483000;max-width:340px;font-family:inherit}
.toastCard{position:relative;display:block;box-sizing:border-box;width:340px;max-width:calc(100vw - 40px);padding:12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)));box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:inherit;text-align:left;cursor:pointer}
.toastCard:hover{background:var(--dsw-alias-interactive-bg-hover)}
.toastCard:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.toastHead{display:flex;align-items:baseline;gap:8px;min-width:0;padding-right:20px}
.toastTitle{flex:none;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.toastCount{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toastClose{position:absolute;top:4px;right:4px;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:15px;line-height:1;cursor:pointer}
.toastClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.toastClose:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.toastList{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:2px;min-width:0}
.toastItem{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.toastName{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit))}
.toastVer{flex:none;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.toastMore{margin-top:2px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.toastHint{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.upgradeOverlay{position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32);font-family:inherit}
.upgradePanel{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;width:100%;max-width:760px;max-height:80vh;overflow:auto;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-primary,var(--dsw-alias-bg-base)));color:var(--dsw-alias-label-primary);font-family:inherit}
.upgradePanel:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.upgradeHead{display:flex;align-items:center;gap:8px;min-width:0}
.upgradeTitle{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.upgradeSpacer{flex:1 1 auto}
.upgradeClose{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:18px;line-height:1;cursor:pointer}
.upgradeClose:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.upgradeClose:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.toastCard{transition:background-color .12s ease-out}}
.diagDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary)))}
.linkBtn:disabled{opacity:.4;cursor:not-allowed}
.diagList{display:flex;flex-direction:column;min-width:0}
.diagItem{display:flex;flex-direction:column;gap:4px;min-width:0;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.diagItem:first-child{padding-top:0;border-top:0}
.diagItem:last-child{padding-bottom:0}
.diagHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.diagPlugin{flex:0 1 auto;min-width:0;overflow-wrap:anywhere;font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit));font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.diagSpacer{flex:1 1 auto;min-width:0}
.diagAt{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.diagTitle{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.diagSummary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.diagToggle{align-self:flex-start}
.diagFixes{display:flex;flex-direction:column;gap:6px;min-width:0;margin-top:2px}
.diagFix{display:flex;flex-direction:column;gap:4px;min-width:0}
.diagFixLabel{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.diagFixText{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.diagNoFix{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.diagFixStatus{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.diagFixStatus.isError{color:var(--dsw-alias-state-error-primary)}
.diagCli{display:flex;align-items:flex-start;flex-wrap:nowrap;gap:8px;min-width:0}
.diagCli>button{flex:none;white-space:nowrap}
.diagCli .cliCommand{flex:1 1 auto;min-width:0;max-width:100%;overflow-x:auto;white-space:pre}
.diagMeta{margin:0 0 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.diagSeverity{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.diagPreview{margin:2px 0 0;max-height:46px;overflow:hidden;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-primary));font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit));font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-all}
.diagToastBox{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}
.diagToastHead{display:flex;align-items:center;gap:6px;min-width:0}
.diagToastTitle{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.diagToastList{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;min-width:0;overflow:hidden}
.diagToastRow{display:flex;flex-direction:column;align-items:flex-start;gap:1px;box-sizing:border-box;width:100%;margin:0;padding:3px 6px;border:0;border-radius:var(--dsw-radius-sm);background:0 0;font-family:inherit;cursor:pointer;text-align:left;min-width:0;overflow:hidden}
.diagToastRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.diagToastRow:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.diagToastName{width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit));font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.diagToastMeta{display:flex;align-items:center;gap:8px;max-width:100%;min-width:0;overflow:hidden}
.diagToastCode{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:11px;line-height:17px;color:var(--dsw-alias-state-error-primary)}
.diagToastAt{flex:none;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.diagToastAll{align-self:flex-start;margin-top:2px}
.diagBanner{flex-wrap:nowrap}
.diagBannerActions{display:flex;align-items:center;gap:8px;flex:none;white-space:nowrap}
.diagBannerActions>*{flex:none}
.diagToastLine{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:0 0;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer}
.diagToastLine:hover{background:var(--dsw-alias-interactive-bg-hover)}
.diagToastLine:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.moreWrap{position:relative;display:inline-flex;flex:none;margin-left:-2px}
.moreBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:28px;padding:0;margin:0;border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:15px;line-height:1;cursor:pointer}
.moreBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.moreBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.moreBtn:disabled{opacity:.35;cursor:not-allowed}
.moreMenu{position:absolute;right:0;top:calc(100% + 2px);z-index:40;box-sizing:border-box;min-width:140px;padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)));display:flex;flex-direction:column;gap:1px}
.moreMenuItem{box-sizing:border-box;display:block;width:100%;height:32px;padding:0 10px;margin:0;border:0;border-radius:var(--dsw-radius-xs);background:0 0;font-family:inherit;font-size:13px;line-height:32px;text-align:left;color:var(--dsw-alias-label-primary);white-space:nowrap;cursor:pointer}
.moreMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.moreMenuItem:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.moreMenuItemDanger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}
.loadFailBadge{display:inline-flex;align-items:center;flex:none;height:16px;padding:0 5px;margin:0;border:.5px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-xs);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary)) 12%, transparent);font-family:inherit;font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));white-space:nowrap;cursor:pointer}
.loadFailBadge:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary)) 20%, transparent)}
.loadFailBadge:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.pkgName{font-family:var(--dsw-font-family-code,var(--ds-font-family-code,inherit));font-size:12px;overflow-wrap:anywhere}
`;

    function injectStyles() {
      if (typeof document === "undefined" || !document.head) return;
      var selector = "style[data-plugin=" + JSON.stringify(PACKAGE_ID) + "]";
      try {
        if (document.querySelector(selector) !== null) return;
      } catch (error) {
        /* selector unsupported — fall through and inject anyway */
      }
      var tag = document.createElement("style");
      tag.dataset.plugin = PACKAGE_ID;
      tag.dataset.pluginCss = PACKAGE_ID + "/lib/client.js";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ */
    /* View                                                                */
    /* ------------------------------------------------------------------ */

    function UpdaterView(props) {
      var tr = makeTranslator(props && props.t);
      var compact = Boolean(props) && props.compact === true;
      /* Optional seed (used by render tests/SSR); the host never passes it. */
      var seed = props && props.initialState && Array.isArray(props.initialState.rows) ? props.initialState : null;

      var statePair = React.useState(seed);
      var state = statePair[0];
      var setState = statePair[1];

      var phasePair = React.useState(seed === null ? "loading" : "ready"); // loading | ready | not-ready | error
      var phase = phasePair[0];
      var setPhase = phasePair[1];

      var failuresPair = React.useState(0);
      var failures = failuresPair[0];
      var setFailures = failuresPair[1];

      var reloadPair = React.useState(0);
      var reloadToken = reloadPair[0];
      var setReloadToken = reloadPair[1];

      var bannerPair = React.useState(null);
      var banner = bannerPair[0];
      var setBanner = bannerPair[1];

      var modalPair = React.useState(null);
      var modal = modalPair[0];
      var setModal = modalPair[1];

      var copyPair = React.useState(null); // null | 'ok' | 'failed'
      var copyState = copyPair[0];
      var setCopyState = copyPair[1];

      var summaryDismissedPair = React.useState(lastDismissedUpdateAllId);
      var summaryDismissed = summaryDismissedPair[0];
      var setSummaryDismissed = summaryDismissedPair[1];

      var rowOpenPair = React.useState({});
      var rowOpen = rowOpenPair[0];
      var setRowOpen = rowOpenPair[1];

      var choicePair = React.useState({});
      var choice = choicePair[0];
      var setChoice = choicePair[1];

      var pendingPair = React.useState(false);
      var pendingConfig = pendingPair[0];
      var setPendingConfig = pendingPair[1];

      var diagnosingPair = React.useState(false);
      var diagnosing = diagnosingPair[0];
      var setDiagnosing = diagnosingPair[1];

      var menuPair = React.useState(null); // row name whose "more" menu is open
      var menuOpen = menuPair[0];
      var setMenuOpen = menuPair[1];

      var pendingActionPair = React.useState({}); // name -> {at, key}
      var pendingAction = pendingActionPair[0];
      var setPendingAction = pendingActionPair[1];

      var draftPair = React.useState("6");
      var intervalDraft = draftPair[0];
      var setIntervalDraft = draftPair[1];

      var controllersRef = React.useRef([]);
      var mountedRef = React.useRef(true);

      React.useEffect(function () {
        mountedRef.current = true;
        return function () {
          mountedRef.current = false;
          abortAll();
        };
      }, []);

      /* The "more" menu closes on outside click, Escape, or a second click. */
      React.useEffect(function () {
        if (!menuOpen) return undefined;
        if (typeof document === "undefined" || !document.addEventListener) return undefined;
        function onPointerDown(event) {
          var target = event && event.target;
          if (target && typeof target.closest === "function" && target.closest(".moreWrap")) return;
          setMenuOpen(null);
        }
        function onKeyDown(event) {
          if (event && (event.key === "Escape" || event.key === "Esc")) {
            setMenuOpen(null);
          }
        }
        document.addEventListener("mousedown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return function () {
          document.removeEventListener("mousedown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [menuOpen]);

      function newController() {
        if (typeof AbortController !== "function") return null;
        var controller = new AbortController();
        if (!Array.isArray(controllersRef.current)) controllersRef.current = [];
        controllersRef.current.push(controller);
        return controller;
      }

      function releaseController(controller) {
        if (!controller) return;
        var list = controllersRef.current;
        if (!Array.isArray(list)) return;
        var index = list.indexOf(controller);
        if (index !== -1) list.splice(index, 1);
      }

      function abortAll() {
        var list = controllersRef.current;
        if (!Array.isArray(list)) return;
        controllersRef.current = [];
        for (var index = 0; index < list.length; index += 1) {
          try {
            list[index].abort();
          } catch (error) {
            /* already aborted */
          }
        }
      }

      function bumpReload() {
        if (!mountedRef.current) return;
        setReloadToken(function (previous) {
          return previous + 1;
        });
      }

      /* --- polling: busy 1.5s, idle 30s, failures back off 5s/15s/60s --- */
      React.useEffect(function () {
        var alive = true;
        var controller = newController();
        var timer = null;
        var localFailures = 0;

        function schedule(delay) {
          if (!alive) return;
          timer = setTimeout(tick, delay);
        }

        function tick() {
          if (!alive) return;
          fetchState(controller ? controller.signal : undefined).then(function (next) {
            if (!alive) return;
            localFailures = 0;
            setFailures(0);
            setState(next);
            setPhase("ready");
            schedule(isBusyState(next) ? 1500 : 30000);
          }, function (error) {
            if (!alive || isAbortError(error)) return;
            localFailures += 1;
            setFailures(localFailures);
            var notReady = Boolean(error) && (error.code === "not-ready" || error.code === "no-fetch");
            setPhase(function (previous) {
              if (notReady) return previous === "ready" ? "ready" : "not-ready";
              return previous === "ready" ? "ready" : "error";
            });
            schedule(localFailures >= 3 ? 60000 : localFailures === 2 ? 15000 : 5000);
          });
        }

        tick();
        return function () {
          alive = false;
          if (timer !== null) clearTimeout(timer);
          if (controller) {
            try {
              controller.abort();
            } catch (error) {
              /* already aborted */
            }
            releaseController(controller);
          }
        };
      }, [reloadToken]);

      function applyStateSnapshot(value) {
        if (!value || typeof value !== "object" || !Array.isArray(value.rows)) return false;
        setState(value);
        setPhase("ready");
        setFailures(0);
        return true;
      }

      function handleActionFailure(error, fallbackKey) {
        if (!mountedRef.current || isAbortError(error)) return;
        setPhase(function (previous) {
          return previous === "loading" ? "error" : previous;
        });
        setBanner({ kind: "error", message: errorMessage(error, tr, fallbackKey || "updateRequestFailed") });
      }

      /**
       * One POST request with its own AbortController, uniform error banner and
       * a state refetch afterwards (busy polling then takes over).
       */
      function perform(path, body, options) {
        var opts = options || {};
        var controller = newController();
        setBanner(null);
        if (opts.pending) setPendingConfig(true);
        postJson(path, body, controller ? controller.signal : undefined).then(function (value) {
          releaseController(controller);
          if (opts.pending) setPendingConfig(false);
          if (!mountedRef.current) return;
          if (opts.applyState) applyStateSnapshot(value);
          if (typeof opts.onDone === "function") opts.onDone(value);
          bumpReload();
        }, function (error) {
          releaseController(controller);
          if (opts.pending) setPendingConfig(false);
          handleActionFailure(error, opts.fallbackKey);
          if (typeof opts.onError === "function") opts.onError(error);
        });
      }

      function handleCheck() {
        perform("/check", { force: true }, { fallbackKey: "checkFailed" });
      }

      function handleCheckRow(row) {
        perform("/check", { names: [row.name], force: true }, { fallbackKey: "checkFailed" });
      }

      function handleUpdateAll() {
        perform("/update-all", {}, { fallbackKey: "updateRequestFailed" });
      }

      function handleUpdate(row, version) {
        if (!version) return;
        perform("/update", { name: row.name, version: version }, {
          fallbackKey: "updateRequestFailed",
          onDone: function () {
            patchEntry(setRowOpen, row.name, null);
            patchEntry(setChoice, row.name, null);
          }
        });
      }

      function handleCancelUpdate(row) {
        var operationId = operationIdOf(row, state);
        var body = operationId ? { operationId: operationId } : {};
        perform("/cancel", body, { fallbackKey: "updateRequestFailed" });
      }

      function handleRestart() {
        perform("/restart", {}, {
          fallbackKey: "restartFailed",
          onDone: function (value) {
            if (value && value.supported === false) {
              setModal({
                kind: "restart",
                message: typeof value.message === "string" && value.message ? value.message : tr("restartGuide")
              });
            } else if (value && typeof value.message === "string" && value.message) {
              setBanner({ kind: "info", message: value.message });
            }
          }
        });
      }

      function applyConfig(patch) {
        perform("/config", { patch: patch }, {
          pending: true,
          applyState: true,
          fallbackKey: "configFailed",
          onError: function () {
            if (state && state.config && typeof state.config.checkIntervalHours === "number") {
              setIntervalDraft(String(state.config.checkIntervalHours));
            }
          }
        });
      }

      function handleSourceChange(event) {
        var next = event && event.target ? event.target.value : "";
        var current = configOf(state).defaultSource;
        if (!next || next === current) return;
        applyConfig({ defaultSource: next });
      }

      function handleAllowPrereleaseChange(event) {
        var next = Boolean(event && event.target && event.target.checked);
        if (next === (configOf(state).allowPrerelease === true)) return;
        applyConfig({ allowPrerelease: next });
      }

      function handleIntervalChange(event) {
        setIntervalDraft(event && event.target ? String(event.target.value) : "");
      }

      function commitInterval() {
        var current = configOf(state).checkIntervalHours;
        var parsed = parseInt(intervalDraft, 10);
        if (!isFinite(parsed)) {
          setIntervalDraft(typeof current === "number" ? String(current) : "6");
          return;
        }
        var next = Math.min(720, Math.max(1, parsed));
        if (next === current) {
          setIntervalDraft(String(next));
          return;
        }
        setIntervalDraft(String(next));
        applyConfig({ checkIntervalHours: next });
      }

      function handleIntervalKeyDown(event) {
        if (event && event.key === "Enter") {
          event.preventDefault();
          commitInterval();
        }
      }

      function handleCopy(text) {
        var settle = function (ok) {
          if (mountedRef.current) setCopyState(ok ? "ok" : "failed");
        };
        var fallback = function () {
          if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            return Promise.resolve(navigator.clipboard.writeText(text)).then(function () {
              return true;
            });
          }
          return Promise.resolve(false);
        };
        try {
          if (typeof writeClipboard === "function") {
            Promise.resolve(writeClipboard(text)).then(function (ok) {
              if (ok === true) return settle(true);
              return fallback().then(settle, function () {
                settle(false);
              });
            }, function () {
              fallback().then(settle, function () {
                settle(false);
              });
            });
            return;
          }
          fallback().then(settle, function () {
            settle(false);
          });
        } catch (error) {
          settle(false);
        }
      }

      function closeModal() {
        setModal(null);
        setCopyState(null);
      }

      function openDiagnosticsModal(plugin) {
        setCopyState(null);
        setModal({ kind: "diagnostics", plugin: typeof plugin === "string" && plugin ? plugin : null });
      }

      /**
       * Run the host's startup diagnostics on demand and merge the returned
       * Diagnostics object into the current snapshot so the banner and the
       * dialog update without waiting for the next poll.
       */
      function handleDiagnose() {
        if (diagnosing) return;
        setDiagnosing(true);
        setBanner(null);
        var controller = newController();
        postJson("/diagnose", { force: true }, controller ? controller.signal : undefined).then(function (value) {
          releaseController(controller);
          if (!mountedRef.current) return;
          setDiagnosing(false);
          setState(function (previous) {
            if (!previous || typeof previous !== "object") return previous;
            var next = {};
            for (var name in previous) {
              if (hasOwn(previous, name)) next[name] = previous[name];
            }
            next.diagnostics = value;
            return next;
          });
        }, function (error) {
          releaseController(controller);
          if (!mountedRef.current) return;
          setDiagnosing(false);
          handleActionFailure(error, "diagnosticsFailed");
        });
      }

      function openFailureModal(row) {
        setCopyState(null);
        setModal({ kind: "failure", row: row });
      }

      /** Failure modal for an immediate action (reinstall / uninstall). */
      function openOperationFailure(error) {
        if (!error || isAbortError(error)) return;
        var message = errorMessage(error, tr, "updateRequestFailed");
        var detail = typeof error.detail === "string" && error.detail ? error.detail : "";
        setCopyState(null);
        setModal({ kind: "opFailure", message: message, detail: detail });
      }

      /** Remember an in-flight per-row action so the row can show it right away. */
      function markPendingAction(name, key) {
        if (!name) return;
        var at = Date.now();
        setPendingAction(function (previous) {
          var next = {};
          for (var existing in previous) {
            if (hasOwn(previous, existing)) next[existing] = previous[existing];
          }
          next[name] = { at: at, key: key };
          return next;
        });
        if (typeof setTimeout !== "function") return;
        setTimeout(function () {
          if (!mountedRef.current) return;
          setPendingAction(function (previous) {
            if (!previous || !hasOwn(previous, name)) return previous;
            var entry = previous[name];
            if (entry && entry.at !== at) return previous;
            var next = {};
            for (var existing in previous) {
              if (hasOwn(previous, existing) && existing !== name) next[existing] = previous[existing];
            }
            return next;
          });
        }, 8000);
      }

      function handleReinstall(row) {
        if (!row || typeof row.name !== "string" || !row.name) return;
        if (isBusyState(state)) return;
        var body = { name: row.name };
        if (typeof row.installedVersion === "string" && row.installedVersion) body.version = row.installedVersion;
        markPendingAction(row.name, "reinstalling");
        perform("/reinstall", body, {
          fallbackKey: "reinstallFailed",
          onError: openOperationFailure
        });
      }

      function openUninstallConfirm(row) {
        if (!row || typeof row.name !== "string" || !row.name) return;
        setCopyState(null);
        setModal({ kind: "uninstall", row: row });
      }

      function handleUninstall(row) {
        if (!row || typeof row.name !== "string" || !row.name) return;
        markPendingAction(row.name, "uninstalling");
        closeModal();
        perform("/uninstall", { name: row.name }, {
          fallbackKey: "uninstallFailed",
          onError: openOperationFailure
        });
      }
      function openUpdateAllReport(operation) {
        setCopyState(null);
        setModal({ kind: "updateAll", operation: operation });
      }

      function dismissUpdateAllSummary(key) {
        lastDismissedUpdateAllId = key;
        setSummaryDismissed(key);
      }

      /** One text line per update-all item, used by both report list and copy. */
      function updateAllReportLines(result) {
        var items = updateAllCounts(result).items;
        var lines = [];
        for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
          var item = items[itemIndex];
          if (!item || typeof item !== "object") continue;
          var itemName = typeof item.name === "string" && item.name ? item.name : "?";
          var fromVersion = item.fromVersion ? String(item.fromVersion) : "?";
          var toVersion = item.toVersion ? String(item.toVersion) : "?";
          var line = itemName + "  " + fromVersion + " → " + toVersion;
          if (item.ok === false) {
            var itemMessage = typeof item.message === "string" && item.message ? item.message : tr("updateFailed");
            line += tr("updateAllFailLine", { message: itemMessage });
          }
          lines.push(line);
        }
        return lines;
      }

      var config = configOf(state);
      var configInterval = typeof config.checkIntervalHours === "number" ? config.checkIntervalHours : null;
      React.useEffect(function () {
        if (configInterval !== null) setIntervalDraft(String(configInterval));
      }, [configInterval]);

      var rows = state && Array.isArray(state.rows) ? state.rows : [];
      var busy = isBusyState(state);
      var sources = buildSources(state, tr);
      var updatableCount = 0;
      for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (isUpdatableRow(rows[rowIndex])) updatableCount += 1;
      }
      var lastCheckedText = tr("lastChecked") + " " + (state && state.lastCheckAt ? formatRelative(state.lastCheckAt, Date.now(), tr) : tr("neverChecked"));

      /* -------------------------- row rendering ------------------------- */

      function renderName(row) {
        var name = typeof row.name === "string" ? row.name : "";
        var kindLabel = null;
        if (row.kind === "local") {
          kindLabel = h("span", { className: "kindLabel", key: "kind" }, tr("statusLocal"));
        } else if (row.kind === "builtin") {
          kindLabel = h("span", { className: "kindLabel", key: "kind" }, tr("statusBuiltin"));
        }
        var loadFailure = row.loadFailure && typeof row.loadFailure === "object" ? row.loadFailure : null;
        var loadBadge = loadFailure
          ? h("button", {
            type: "button",
            className: "loadFailBadge",
            title: typeof loadFailure.summary === "string" && loadFailure.summary ? loadFailure.summary : tr("loadFailedBadge"),
            "aria-label": tr("loadFailureDetails"),
            onClick: function (event) {
              if (event && typeof event.stopPropagation === "function") event.stopPropagation();
              openDiagnosticsModal(name);
            }
          }, tr("loadFailedBadge"))
          : null;
        var subParts = [];
        if (row.bundleId && row.bundleId !== name) {
          subParts.push(h("span", { className: "bundle", key: "bundle", title: String(row.bundleId) }, String(row.bundleId)));
        }
        return h("div", { className: "nameCell" },
          h("span", { className: "nameLine" },
            h("span", { className: "name", title: name }, name),
            loadBadge,
            kindLabel
          ),
          subParts.length > 0 ? h("span", { className: "sub" }, subParts) : null
        );
      }

      function renderStatus(row) {
        var status = row.status;
        var reasonMessage = row.reason && typeof row.reason.message === "string" ? row.reason.message : "";
        var staleHint = row.stale === true ? h("span", { className: "hint" }, tr("stale")) : null;
        if (status === "checking") {
          return h("span", { className: "status" }, h(StateDot, { state: "ongoing" }), h("span", { className: "statusText" }, tr("checking")));
        }
        if (status === "latest") {
          return h("span", { className: "status" }, h("span", { className: "statusText muted", title: reasonMessage || undefined }, tr("statusLatest")), staleHint);
        }
        if (status === "update-latest") {
          return h("span", { className: "status" }, h("span", { className: "statusText", title: reasonMessage || undefined }, tr("statusNewer")), staleHint);
        }
        if (status === "update-compatible") {
          return h("span", { className: "status" }, h("span", { className: "statusText", title: reasonMessage || undefined }, tr("statusNewer")), staleHint);
        }
        if (status === "switch-compatible" || status === "incompatible-no-compatible") {
          return h("span", { className: "status" }, h(Tag, { tone: "warning" }, tr("statusIncompatible")));
        }
        if (status === "local") {
          return h("span", { className: "status" }, h(Tag, { tone: "neutral" }, tr("statusLocal")));
        }
        if (status === "builtin") {
          return h("span", { className: "status" }, h(Tag, { tone: "neutral" }, tr("statusBuiltin")));
        }
        if (status === "error") {
          var code = row.error && typeof row.error.code === "string" ? row.error.code : "";
          var text = code === "not-checked" ? tr("statusNotChecked") : tr("statusError");
          var message = row.error && typeof row.error.message === "string" ? row.error.message : "";
          var errorDetail = row.error && typeof row.error.detail === "string" ? row.error.detail : "";
          var titleText = message;
          if (errorDetail) titleText = message ? message + "\n" + errorDetail : errorDetail;
          if (titleText.length > 500) titleText = titleText.slice(0, 500);
          return h("span", { className: "status" }, h(StateDot, { state: "error" }), h("span", { className: "statusText", title: titleText || undefined }, text));
        }
        return h("span", { className: "status" }, h("span", { className: "statusText muted" }, typeof status === "string" && status ? status : tr("statusNotChecked")));
      }

      function moreMenuDisabledReason(row) {
        if (operationOfRow(row) !== null) return tr("moreActionsBusy");
        if (findQueuedOperation(state, row.name) !== null) return tr("moreActionsBusy");
        if (row.selfPlugin === true) return tr("moreActionsSelf");
        if (row.kind !== "registry") return tr("moreActionsUnmanaged");
        return "";
      }

      function renderMoreMenu(row) {
        var name = typeof row.name === "string" ? row.name : "";
        var open = menuOpen !== null && menuOpen === name;
        var disabledReason = moreMenuDisabledReason(row);
        var menu = open
          ? h("div", { className: "moreMenu", role: "menu", "aria-label": tr("moreActions") },
            h("button", {
              type: "button",
              role: "menuitem",
              className: "moreMenuItem",
              onClick: function () {
                setMenuOpen(null);
                handleReinstall(row);
              }
            }, tr("reinstall")),
            h("button", {
              type: "button",
              role: "menuitem",
              className: "moreMenuItem moreMenuItemDanger",
              onClick: function () {
                setMenuOpen(null);
                openUninstallConfirm(row);
              }
            }, tr("uninstall"))
          )
          : null;
        return h("span", { className: "moreWrap", key: "more" },
          h("button", {
            type: "button",
            className: "moreBtn",
            "aria-haspopup": "menu",
            "aria-expanded": open ? "true" : "false",
            "aria-label": name ? tr("moreActions") + ": " + name : tr("moreActions"),
            title: disabledReason || tr("moreActions"),
            disabled: Boolean(disabledReason),
            onClick: function (event) {
              if (event && typeof event.stopPropagation === "function") event.stopPropagation();
              setMenuOpen(open ? null : name);
            }
          }, "⋯"),
          menu
        );
      }

      function actionsWithMore(row, first) {
        var children = [first];
        for (var extraIndex = 2; extraIndex < arguments.length; extraIndex += 1) {
          children.push(arguments[extraIndex]);
        }
        children.push(renderMoreMenu(row));
        return h.apply(null, ["span", { className: "actions" }].concat(children));
      }

      function renderActions(row) {
        var operation = operationOfRow(row);
        if (operation) {
          var queued = operation.state === "queued" || operation.phase === "queued";
          if (queued) {
            return actionsWithMore(row, h(StateDot, { state: "idle" }), h("span", { className: "actionText" }, tr("queued")));
          }
          return actionsWithMore(row,
            h(StateDot, { state: "ongoing" }),
            h("span", { className: "actionText", title: operationMessage(operation) || undefined }, tr("updating")),
            h(Button, { variant: "ghost", size: "sm", onClick: function () { handleCancelUpdate(row); } }, tr("cancelUpdate"))
          );
        }
        if (findQueuedOperation(state, row.name) !== null) {
          return actionsWithMore(row, h(StateDot, { state: "idle" }), h("span", { className: "actionText" }, tr("queued")));
        }
        if (row.lastUpdate && row.lastUpdate.ok === false) {
          return actionsWithMore(row,
            h("span", { className: "actionText actionTextDanger" }, tr("updateFailed")),
            h(Button, { variant: "ghost", size: "sm", onClick: function () { openFailureModal(row); } }, tr("viewDetails"))
          );
        }
        if (row.pendingRestart === true) {
          return actionsWithMore(row,
            h("span", { className: "actionText" }, tr("pendingRestart")),
            h(Button, { variant: "outline", size: "sm", onClick: handleRestart }, tr("restartDsh"))
          );
        }
        var pendingEntry = pendingAction && hasOwn(pendingAction, row.name) ? pendingAction[row.name] : null;
        var pendingActive = Boolean(pendingEntry && typeof pendingEntry.at === "number" && Date.now() - pendingEntry.at < 8000);
        if (pendingActive && typeof pendingEntry.key === "string" && pendingEntry.key) {
          return actionsWithMore(row,
            h(StateDot, { state: "ongoing" }),
            h("span", { className: "actionText" }, tr(pendingEntry.key))
          );
        }
        if (row.status === "update-latest") {
          var latestTarget = targetVersion(row);
          return actionsWithMore(row,
            h(Button, {
              variant: "outline",
              size: "sm",
              disabled: busy,
              onClick: function () { handleUpdate(row, latestTarget); }
            }, tr("updateTo", { version: latestTarget }))
          );
        }
        if (row.status === "update-compatible") {
          var openChoose = rowOpen[row.name] === "choose";
          return actionsWithMore(row,
            h(Button, {
              variant: "outline",
              size: "sm",
              "aria-expanded": openChoose ? "true" : "false",
              disabled: busy,
              onClick: function () { patchEntry(setRowOpen, row.name, openChoose ? null : "choose"); }
            }, tr("updateToCompatible", { version: targetVersion(row) }))
          );
        }
        if (row.status === "switch-compatible") {
          var openConfirm = rowOpen[row.name] === "confirm";
          return actionsWithMore(row,
            h(Button, {
              variant: "outline",
              size: "sm",
              "aria-expanded": openConfirm ? "true" : "false",
              disabled: busy,
              onClick: function () { patchEntry(setRowOpen, row.name, openConfirm ? null : "confirm"); }
            }, tr("switchToCompatible", { version: targetVersion(row) }))
          );
        }
        if (row.status === "error") {
          return actionsWithMore(row,
            h(Button, { variant: "ghost", size: "sm", onClick: function () { handleCheckRow(row); } }, tr("retry"))
          );
        }
        if (row.status === "incompatible-no-compatible") {
          var openIncompatible = rowOpen[row.name] === "reason";
          return actionsWithMore(row,
            h(Button, {
              variant: "ghost",
              size: "sm",
              "aria-expanded": openIncompatible ? "true" : "false",
              onClick: function () {
                patchEntry(setRowOpen, row.name, openIncompatible ? null : "reason");
              }
            }, tr("viewReason"))
          );
        }
        // latest / local / builtin / checking: keep the fixed action slot empty
        // so column widths never shift.
        return actionsWithMore(row, h("span", { className: "actionsPlaceholder", "aria-hidden": "true" }));
      }

      function renderDetail(row) {
        var name = row.name;
        var open = rowOpen[name];
        var children = [];

        if (row.status === "switch-compatible") {
          children.push(h("p", { className: "note", key: "note" },
            tr("switchNote", { current: row.installedVersion || "?", target: targetVersion(row) })));
          if (open === "confirm") {
            children.push(h("div", { className: "panelFooter", key: "footer" },
              h(Button, { variant: "ghost", size: "sm", onClick: function () { patchEntry(setRowOpen, name, null); } }, tr("cancel")),
              h(Button, { variant: "primary", size: "sm", disabled: busy, onClick: function () { handleUpdate(row, targetVersion(row)); } }, tr("confirmSwitch"))
            ));
          }
        }

        if (row.status === "update-compatible" && open === "choose") {
          var compatibleVersion = targetVersion(row);
          var altVersion = row.altTarget && typeof row.altTarget.version === "string" && row.altTarget.version ? row.altTarget.version : "";
          var selected = choice[name] || compatibleVersion;
          var options = [
            h("label", { className: "option", key: "compatible" },
              h("input", {
                type: "radio",
                className: "radio",
                name: "updater-choice-" + name,
                checked: selected === compatibleVersion,
                onChange: function () { patchEntry(setChoice, name, compatibleVersion); }
              }),
              h("span", { className: "optionText" }, h("span", null, tr("updateToCompatible", { version: compatibleVersion })))
            )
          ];
          if (altVersion && altVersion !== compatibleVersion) {
            options.push(h("label", { className: "option", key: "latest" },
              h("input", {
                type: "radio",
                className: "radio",
                name: "updater-choice-" + name,
                checked: selected === altVersion,
                onChange: function () { patchEntry(setChoice, name, altVersion); }
              }),
              h("span", { className: "optionText" },
                h("span", null, tr("updateLatestOption", { version: altVersion })),
                h("span", { className: "optionRisk" }, tr("latestRisk"))
              )
            ));
          }
          children.push(h("div", { className: "panel", key: "panel" },
            h("div", { className: "options" }, options),
            row.source === "github" || row.source === "github-mirror"
              ? h("p", { className: "panelNote" }, tr("githubRiskNote"))
              : null,
            h("div", { className: "panelFooter" },
              h(Button, { variant: "ghost", size: "sm", onClick: function () { patchEntry(setRowOpen, name, null); } }, tr("cancel")),
              h(Button, { variant: "primary", size: "sm", disabled: busy, onClick: function () { handleUpdate(row, selected); } }, tr("confirmUpdate"))
            )
          ));
        }

        if (row.status === "incompatible-no-compatible" && open === "reason") {
          var unmet = row.reason && Array.isArray(row.reason.unmet) ? row.reason.unmet : [];
          var reasonChildren = [];
          if (unmet.length === 0) {
            reasonChildren.push(h("p", { className: "note", key: "empty" },
              row.reason && typeof row.reason.message === "string" && row.reason.message ? row.reason.message : tr("reasonEmpty")));
          } else {
            reasonChildren.push(h("div", { className: "unmetHead", key: "head" },
              h("span", null, tr("unmetHeadName")),
              h("span", null, tr("unmetHeadRange")),
              h("span", null, tr("unmetHeadActual"))
            ));
            for (var unmetIndex = 0; unmetIndex < unmet.length; unmetIndex += 1) {
              var item = unmet[unmetIndex] && typeof unmet[unmetIndex] === "object" ? unmet[unmetIndex] : {};
              reasonChildren.push(h("div", { className: "unmet", key: "unmet-" + unmetIndex },
                h("span", { title: typeof item.name === "string" ? item.name : undefined }, typeof item.name === "string" && item.name ? item.name : "—"),
                h("span", { title: typeof item.range === "string" ? item.range : undefined }, typeof item.range === "string" && item.range ? item.range : "—"),
                h("span", { title: typeof item.actual === "string" ? item.actual : undefined }, typeof item.actual === "string" && item.actual ? item.actual : "—")
              ));
            }
          }
          children.push(h("div", { className: "detail", key: "reason" }, reasonChildren));
        }

        if (children.length === 0) return null;
        return h("div", { className: "detailWrap" }, children);
      }

      function renderRowBlock(row, index) {
        var key = (typeof row.name === "string" ? row.name : "row") + "#" + index;
        var installedText = row.installedVersion ? String(row.installedVersion) : "—";
        var nextVersion = "";
        if (row.status === "update-latest" || row.status === "update-compatible" || row.status === "switch-compatible") {
          var pendingVersion = targetVersion(row);
          if (pendingVersion && pendingVersion !== installedText) nextVersion = pendingVersion;
        }
        return h("div", { className: "rowBlock", key: key },
          h("div", { className: "row" },
            renderName(row),
            h("div", { className: "versionCell" },
              h("span", { className: "version", title: installedText }, installedText),
              nextVersion !== ""
                ? h("span", { className: "versionNext", title: installedText + " → " + nextVersion }, "→ " + nextVersion)
                : null),
            h("div", { className: "statusCell" }, renderStatus(row)),
            renderActions(row)
          ),
          renderDetail(row)
        );
      }

      /* --------------------------- fragments --------------------------- */

      function renderNotice() {
        if (phase === "not-ready") {
          return h("div", { className: "notice", role: "status" },
            h("span", { className: "noticeText" }, tr("notReady")),
            h(Button, { variant: "ghost", size: "sm", onClick: bumpReload }, tr("retry"))
          );
        }
        if (banner) {
          return h("div", { className: "notice" + (banner.kind === "error" ? " noticeError" : ""), role: banner.kind === "error" ? "alert" : "status" },
            h("span", { className: "noticeText" }, banner.message),
            h("button", { type: "button", className: "linkBtn", onClick: function () { setBanner(null); } }, tr("close"))
          );
        }
        if (phase === "error" && state === null) {
          return h("div", { className: "notice", role: "alert" },
            h("span", { className: "noticeText" }, tr("loadFailed")),
            h(Button, { variant: "ghost", size: "sm", onClick: bumpReload }, tr("retry"))
          );
        }
        if (failures > 0 && state !== null) {
          return h("div", { className: "notice", role: "status" },
            h("span", { className: "noticeText" }, tr("refreshFailed")),
            h(Button, { variant: "ghost", size: "sm", onClick: bumpReload }, tr("retry"))
          );
        }
        return null;
      }

      function renderUpdateAllSummary() {
        if (phase !== "ready" || state === null) return null;
        var operation = latestUpdateAllOperation(state);
        if (operation === null) return null;
        var key = updateAllSummaryKey(operation);
        if (key === summaryDismissed || key === lastDismissedUpdateAllId) return null;
        var counts = updateAllCounts(operation.result);
        var text = counts.failed > 0
          ? tr("updateAllPartial", { ok: String(counts.succeeded), failed: String(counts.failed) })
          : tr("updateAllSucceeded", { n: String(counts.succeeded) });
        return h("div", { className: "summary", role: "status" },
          h("span", { className: "summaryText", title: text }, text),
          counts.failed > 0
            ? h(Button, {
                variant: "ghost",
                size: "sm",
                onClick: function () { openUpdateAllReport(operation); }
              }, tr("viewReport"))
            : null,
          h("button", {
            type: "button",
            className: "linkBtn",
            onClick: function () { dismissUpdateAllSummary(key); }
          }, tr("close"))
        );
      }

      function renderDiagnosticsBanner() {
        if (phase !== "ready" || state === null) return null;
        var items = diagnosticItems(state);
        if (items.length === 0) return null;
        var text = tr("diagnosticsBanner", { n: String(diagnosticPluginCount(items)) });
        return h("div", { className: "summary diagBanner", role: "status" },
          h("span", { className: "diagDot", "aria-hidden": "true" }),
          h("span", { className: "summaryText", title: text }, text),
          h("div", { className: "diagBannerActions" },
            h(Button, { variant: "ghost", size: "sm", onClick: openDiagnosticsModal }, tr("diagnosticsView")),
            h("button", {
              type: "button",
              className: "linkBtn",
              disabled: diagnosing,
              onClick: handleDiagnose
            }, diagnosing ? tr("diagnosticsScanning") : tr("diagnosticsRerun"))
          )
        );
      }

      function renderToolbar() {
        var options = [];
        for (var index = 0; index < sources.length; index += 1) {
          options.push(h("option", { key: sources[index].id, value: sources[index].id }, sources[index].label));
        }
        return h("div", { className: "toolbar" },
          h("span", { className: "toolLabel" }, tr("source")),
          h("select", {
            className: "select",
            value: config.defaultSource || "npm-mirror",
            disabled: phase !== "ready" || pendingConfig,
            "aria-label": tr("source"),
            onChange: handleSourceChange
          }, options),
          h(Button, {
            variant: "outline",
            size: "sm",
            icon: iconNode("IconRefreshOutlineRegular"),
            disabled: phase !== "ready" || busy || pendingConfig,
            onClick: handleCheck
          }, tr("checkNow")),
          h(Button, {
            variant: "outline",
            size: "sm",
            title: tr("diagnosticsButton"),
            disabled: phase !== "ready" || diagnosing,
            onClick: handleDiagnose
          }, diagnosing ? tr("diagnosticsScanning") : tr("diagnosticsButton")),
          updatableCount > 0 ? h(Button, {
            variant: "primary",
            size: "sm",
            title: tr("oneClickUpdateHint", { n: String(updatableCount) }),
            disabled: phase !== "ready" || busy || pendingConfig,
            onClick: handleUpdateAll
          }, tr("updateAll")) : null,
          h("div", { className: "toolbarSpacer" }),
          state && state.checking === true ? h("span", { className: "lastChecked" }, tr("checking")) : null,
          h("span", { className: "lastChecked" }, lastCheckedText)
        );
      }

      function renderSettings() {
        return h("div", { className: "settings" },
          h("label", { className: "check" },
            h("input", {
              type: "checkbox",
              className: "checkbox",
              checked: config.allowPrerelease === true,
              disabled: phase !== "ready" || pendingConfig,
              onChange: handleAllowPrereleaseChange
            }),
            h("span", null, tr("allowPrerelease"))
          ),
          h("label", { className: "check" },
            h("span", null, tr("interval")),
            h("input", {
              type: "number",
              className: "number",
              min: 1,
              max: 720,
              step: 1,
              value: intervalDraft,
              disabled: phase !== "ready" || pendingConfig,
              "aria-label": tr("interval"),
              onChange: handleIntervalChange,
              onBlur: commitInterval,
              onKeyDown: handleIntervalKeyDown
            }),
            h("span", null, tr("hours"))
          )
        );
      }

      function renderSkeleton() {
        var skeletonRows = [];
        var widths = [["52%", "42%", "36%", "28%"], ["44%", "30%", "46%", "22%"], ["60%", "38%", "30%", "32%"]];
        for (var index = 0; index < 3; index += 1) {
          var line = widths[index];
          skeletonRows.push(h("div", { className: "row skeletonRow", key: "skeleton-" + index },
            h("span", { className: "skeleton", style: { width: line[0] } }),
            h("span", { className: "skeleton", style: { width: line[1] } }),
            h("span", { className: "skeleton", style: { width: line[2] } }),
            h("span", { className: "skeleton", style: { width: line[3], justifySelf: "end" } })
          ));
        }
        return h("div", { className: "loadingRows", "aria-busy": "true", "aria-label": tr("loading") }, skeletonRows);
      }

      function renderTable() {
        var bodyRows = [];
        for (var index = 0; index < rows.length; index += 1) {
          bodyRows.push(renderRowBlock(rows[index], index));
        }
        var body;
        if (state === null) {
          body = renderSkeleton();
        } else if (bodyRows.length === 0) {
          body = h("div", { className: "emptyRow" }, tr("empty"));
        } else {
          body = h("div", { className: "bodyRows" }, bodyRows);
        }
        return h("div", { className: "table", "aria-label": tr("title") },
          h("div", { className: "row head" },
            h("div", null, tr("colPlugin")),
            h("div", null, tr("colInstalled")),
            h("div", null, tr("colStatus")),
            h("div", { className: "headActions" }, tr("colActions"))
          ),
          body
        );
      }

      function renderModal() {
        if (!modal) return null;
        if (modal.kind === "diagnostics") {
          var diagnosticsFilter = typeof modal.plugin === "string" && modal.plugin ? modal.plugin : "";
          return h(DiagnosticsDialog, {
            items: diagnosticItemsFor(state, diagnosticsFilter),
            pluginFilter: diagnosticsFilter,
            meta: diagnosticsOf(state),
            t: props.t,
            onClose: closeModal,
            onChanged: function () {
              closeModal();
              bumpReload();
            }
          });
        }
        if (modal.kind === "uninstall") {
          var uninstallRow = modal.row || {};
          return h(Modal, {
            open: true,
            onClose: closeModal,
            title: tr("uninstallConfirmTitle"),
            closeLabel: tr("close"),
            footer: h("div", { className: "modalFooter" },
              h(Button, { variant: "ghost", size: "sm", onClick: closeModal }, tr("cancel")),
              h(Button, { variant: "primary", size: "sm", onClick: function () { handleUninstall(uninstallRow); } }, tr("uninstallConfirmAction"))
            )
          },
            h("div", { className: "modalBody" },
              h("p", { className: "modalText" },
                h("code", { className: "pkgName" }, String(uninstallRow.name || "")),
                uninstallRow.installedVersion ? " " + String(uninstallRow.installedVersion) : null
              ),
              h("p", { className: "modalText" }, tr("uninstallConfirmBody"))
            )
          );
        }
        if (modal.kind === "opFailure") {
          var opDetail = typeof modal.detail === "string" && modal.detail ? modal.detail : "";
          var opMessage = typeof modal.message === "string" && modal.message ? modal.message : tr("updateFailed");
          return h(Modal, {
            open: true,
            onClose: closeModal,
            title: tr("failTitle"),
            closeLabel: tr("close"),
            footer: h("div", { className: "modalFooter" },
              copyState === "ok" ? h("span", { className: "copiedNote" }, tr("copied")) : null,
              copyState === "failed" ? h("span", { className: "copiedNote" }, tr("copyFailed")) : null,
              h(Button, { variant: "outline", size: "sm", onClick: function () { handleCopy(opDetail || opMessage); } }, tr("copy")),
              h(Button, { variant: "primary", size: "sm", onClick: closeModal }, tr("close"))
            )
          },
            h("div", { className: "modalBody" },
              h("p", { className: "modalText" }, opMessage),
              opDetail ? h("pre", { className: "code", tabIndex: 0 }, opDetail) : null
            )
          );
        }
        if (modal.kind === "restart") {
          return h(Modal, {
            open: true,
            onClose: closeModal,
            title: tr("restartTitle"),
            closeLabel: tr("close"),
            footer: h("div", { className: "modalFooter" },
              h(Button, { variant: "primary", size: "sm", onClick: closeModal }, tr("close"))
            )
          },
            h("div", { className: "modalBody" },
              h("p", { className: "modalText" }, modal.message || tr("restartGuide"))
            )
          );
        }
        if (modal.kind === "updateAll") {
          var reportOperation = modal.operation || {};
          var reportResult = reportOperation.result || {};
          var reportCounts = updateAllCounts(reportResult);
          var reportLines = updateAllReportLines(reportResult);
          var reportText = reportLines.join("\n");
          var reportSummary = reportCounts.failed > 0
            ? tr("updateAllPartial", { ok: String(reportCounts.succeeded), failed: String(reportCounts.failed) })
            : tr("updateAllSucceeded", { n: String(reportCounts.succeeded) });
          return h(Modal, {
            open: true,
            onClose: closeModal,
            title: tr("updateAllReportTitle"),
            closeLabel: tr("close"),
            footer: h("div", { className: "modalFooter" },
              copyState === "ok" ? h("span", { className: "copiedNote" }, tr("copied")) : null,
              copyState === "failed" ? h("span", { className: "copiedNote" }, tr("copyFailed")) : null,
              h(Button, { variant: "outline", size: "sm", onClick: function () { handleCopy(reportText); } }, tr("copy")),
              h(Button, { variant: "primary", size: "sm", onClick: closeModal }, tr("close"))
            )
          },
            h("div", { className: "modalBody" },
              h("p", { className: "modalText" }, reportSummary),
              reportLines.length > 0
                ? h("pre", { className: "code", tabIndex: 0 }, reportText)
                : h("p", { className: "modalText" }, tr("updateAllNoItems"))
            )
          );
        }
        var row = modal.row || {};
        var update = row.lastUpdate && typeof row.lastUpdate === "object" ? row.lastUpdate : {};
        var detailText = failureDetailText(row, update, tr);
        var message = typeof update.message === "string" && update.message
          ? update.message
          : row.error && typeof row.error.message === "string" && row.error.message
            ? row.error.message
            : tr("updateFailed");
        var cliCommand = cliCommandFor(
          state && state.profile && typeof state.profile.dir === "string" ? state.profile.dir : "",
          row.name,
          typeof update.toVersion === "string" ? update.toVersion : targetVersion(row)
        );
        return h(Modal, {
          open: true,
          onClose: closeModal,
          title: tr("failTitle"),
          closeLabel: tr("close"),
          footer: h("div", { className: "modalFooter" },
            copyState === "ok" ? h("span", { className: "copiedNote" }, tr("copied")) : null,
            copyState === "failed" ? h("span", { className: "copiedNote" }, tr("copyFailed")) : null,
            cliCommand
              ? h(Button, { variant: "outline", size: "sm", onClick: function () { handleCopy(cliCommand); } }, tr("cliHintCopy"))
              : null,
            h(Button, { variant: "outline", size: "sm", onClick: function () { handleCopy(detailText); } }, tr("copyLog")),
            h(Button, { variant: "primary", size: "sm", onClick: closeModal }, tr("close"))
          )
        },
          h("div", { className: "modalBody" },
            h("p", { className: "modalText" }, message),
            h("pre", { className: "code", tabIndex: 0 }, detailText),
            h("div", { className: "cliHint" },
              h("p", { className: "cliHintText" }, tr("cliHintTitle")),
              h("div", { className: "cliRow" },
                h("code", { className: "cliCommand", tabIndex: 0, title: cliCommand }, cliCommand)
              )
            )
          )
        );
      }

      return h("div", { className: "updater" },
        compact ? null : h("div", { className: "updaterHead" },
          h("h2", { className: "heading" }, tr("title")),
          h("p", { className: "intro" }, tr("intro"))
        ),
        renderNotice(),
        renderToolbar(),
        renderDiagnosticsBanner(),
        renderUpdateAllSummary(),
        renderSettings(),
        renderTable(),
        renderModal()
      );
    }

    function configOf(snapshot) {
      if (snapshot && snapshot.config && typeof snapshot.config === "object") return snapshot.config;
      return {};
    }

    function patchEntry(setter, name, value) {
      setter(function (previous) {
        var next = {};
        if (previous && typeof previous === "object") {
          for (var key in previous) {
            if (!hasOwn(previous, key) || key === name) continue;
            next[key] = previous[key];
          }
        }
        if (value !== null && value !== undefined) next[name] = value;
        return next;
      });
    }

    /**
     * Build the terminal fallback command shown when an update fails because
     * files are locked by the running desktop app. The desktop app has to be
     * quit to free the locks, which also removes the UI, so the user needs a
     * ready-to-paste CLI command.
     */
    function cliCommandFor(profileDir, name, toVersion) {
      var base = typeof profileDir === "string" && profileDir ? profileDir : "%USERPROFILE%\\.dsh\\profiles\\desktop";
      base = base.replace(/[\\/]+$/, "").replace(/\//g, "\\");
      var packageName = typeof name === "string" && name ? name : "<name>";
      var version = typeof toVersion === "string" && toVersion ? toVersion : "<version>";
      return "node \"" + base + "\\node_modules\\dsh-plugin-update-manager\\lib\\cli.js\" update " + packageName + " --version " + version;
    }

    function failureDetailText(row, update, tr) {
      var lines = [];
      lines.push(tr("detailPackage") + ": " + (typeof row.name === "string" ? row.name : ""));
      if (update && typeof update.fromVersion === "string" && update.fromVersion) lines.push(tr("detailFrom") + ": " + update.fromVersion);
      if (update && typeof update.toVersion === "string" && update.toVersion) lines.push(tr("detailTo") + ": " + update.toVersion);
      if (update && update.at) lines.push(tr("detailAt") + ": " + String(update.at));
      var message = update && typeof update.message === "string" && update.message
        ? update.message
        : row && row.error && typeof row.error.message === "string" && row.error.message
          ? row.error.message
          : "";
      if (message) lines.push(tr("detailMessage") + ": " + message);
      var rawDetail = update && typeof update.detail === "string" && update.detail
        ? update.detail
        : row && row.error && typeof row.error.detail === "string" && row.error.detail
          ? row.error.detail
          : "";
      if (rawDetail) {
        lines.push("");
        lines.push(tr("detailOutput"));
        lines.push(rawDetail);
      }
      return lines.join("\n");
    }

    /* ------------------------------------------------------------------ */
    /* Slot entry components                                              */
    /* ------------------------------------------------------------------ */

    function Section(props) {
      var next = {};
      if (props) {
        for (var key in props) {
          if (hasOwn(props, key)) next[key] = props[key];
        }
      }
      next.compact = false;
      return h(UpdaterView, next);
    }

    function TabPanel(props) {
      var next = {};
      if (props) {
        for (var key in props) {
          if (hasOwn(props, key)) next[key] = props[key];
        }
      }
      next.compact = true;
      return h(UpdaterView, next);
    }

    /* ------------------------------------------------------------------ */
    /* Boot toast + upgrade overlay                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Bottom-right reminder that appears once per boot when compatible
     * updates are available. Clicking the card opens a self-drawn upgrade
     * dialog (no host settings API is exposed), and the dialog reuses the
     * full UpdaterView table so every row keeps its inline actions.
     *
     * Only rendered after the first check produced rows; while the host has
     * not checked yet the component retries every 3s (up to 90s).
     */
    /* ------------------------------------------------------------------ */
    /* Startup diagnostics dialog (shared by the settings view and toast)  */
    /* ------------------------------------------------------------------ */

    function DiagnosticsDialog(props) {
      var tr = makeTranslator(props && props.t);
      var pluginFilter = props && typeof props.pluginFilter === "string" ? props.pluginFilter : "";
      var rawItems = props && Array.isArray(props.items) ? props.items : [];
      var items = rawItems;
      if (pluginFilter) {
        items = [];
        for (var filterIndex = 0; filterIndex < rawItems.length; filterIndex += 1) {
          var filterItem = rawItems[filterIndex];
          if (filterItem && filterItem.plugin === pluginFilter) items.push(filterItem);
        }
      }

      var expandedPair = React.useState({});
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];

      var copyPair = React.useState(null);
      var copyState = copyPair[0];
      var setCopyState = copyPair[1];

      var pendingPair = React.useState(null);
      var pendingFix = pendingPair[0];
      var setPendingFix = pendingPair[1];

      var statusPair = React.useState(null);
      var fixStatus = statusPair[0];
      var setFixStatus = statusPair[1];

      function toggleItem(key) {
        setExpanded(function (previous) {
          var next = {};
          for (var name in previous) {
            if (hasOwn(previous, name) && name !== key) next[name] = previous[name];
          }
          if (previous[key] !== true) next[key] = true;
          return next;
        });
      }

      function doCopy(text, key) {
        copyTextToClipboard(text).then(function (ok) {
          setCopyState({ key: key, ok: ok === true });
        });
      }

      function runUpdateFix(item, fix, key) {
        if (typeof props.onUpdateFix === "function") {
          props.onUpdateFix(item, fix);
          return;
        }
        if (pendingFix) return;
        setPendingFix(key);
        setFixStatus(null);
        Promise.resolve(postJson("/update", { name: item.plugin, version: fix.version })).then(function () {
          setPendingFix(null);
          setFixStatus({ key: key, ok: true, message: tr("diagnosticsUpdateQueued") });
          if (typeof props.onChanged === "function") props.onChanged();
        }, function (error) {
          setPendingFix(null);
          setFixStatus({ key: key, ok: false, message: errorMessage(error, tr, "updateRequestFailed") });
        });
      }

      function renderFix(item, fix, index) {
        if (!fix || typeof fix !== "object") return null;
        var key = diagnosticFixKey(item, items.indexOf(item)) + ":fix:" + index;
        var label = typeof fix.label === "string" && fix.label ? fix.label : "";
        if (fix.kind === "update") {
          var version = typeof fix.version === "string" && fix.version ? fix.version : "";
          var pluginName = typeof item.plugin === "string" && item.plugin ? item.plugin : "";
          var busy = pendingFix === key;
          var status = fixStatus && fixStatus.key === key ? fixStatus : null;
          return h("div", { className: "diagFix", key: key },
            h(Button, {
              variant: "primary",
              size: "sm",
              title: pluginName ? undefined : tr("diagnosticsUnknownPlugin"),
              disabled: Boolean(pendingFix) || pluginName === "",
              onClick: function () {
                runUpdateFix(item, fix, key);
              }
            }, busy ? tr("diagnosticsUpdating") : tr("diagnosticsUpdateTo", { version: version || label || "?" })),
            status
              ? h("span", { className: "diagFixStatus" + (status.ok ? "" : " isError") }, status.message)
              : null
          );
        }
        if (fix.kind === "command") {
          var command = typeof fix.command === "string" ? fix.command : "";
          var cwd = typeof fix.cwd === "string" ? fix.cwd : "";
          if (!command && !label) return null;
          var copyText = (cwd ? "cd " + cwd + "\n" : "") + command;
          var copyKey = key + ":copy";
          var copyInfo = copyState && copyState.key === copyKey ? copyState : null;
          return h("div", { className: "diagFix", key: key },
            label ? h("p", { className: "diagFixLabel" }, label) : null,
            cwd ? h("p", { className: "diagFixLabel" }, tr("diagnosticsFixHint")) : null,
            h("div", { className: "cliRow diagCli" },
              h("code", { className: "cliCommand", tabIndex: 0, title: copyText },
                cwd
                  ? h(React.Fragment, null,
                      h("span", { className: "diagCliLine", title: "cd " + cwd }, "cd " + cwd),
                      "\n",
                      h("span", { className: "diagCliLine", title: command }, command)
                    )
                  : h("span", { className: "diagCliLine", title: command }, command)
              ),
              h(Button, {
                variant: "ghost",
                size: "sm",
                onClick: function () {
                  doCopy(copyText, copyKey);
                }
              }, copyInfo && copyInfo.ok ? tr("diagnosticsCopied") : tr("diagnosticsCopyCommand"))
            ),
            copyInfo && copyInfo.ok === false
              ? h("span", { className: "diagFixStatus isError" }, tr("copyFailed"))
              : null
          );
        }
        var text = typeof fix.detail === "string" && fix.detail ? fix.detail : label;
        if (!text) return null;
        return h("div", { className: "diagFix", key: key },
          h("p", { className: "diagFixText" }, text)
        );
      }

      function renderItem(item, index) {
        if (!item || typeof item !== "object") return null;
        var itemKey = diagnosticFixKey(item, index);
        var open = expanded[itemKey] === true;
        var plugin = typeof item.plugin === "string" && item.plugin ? item.plugin : tr("diagnosticsUnknownPlugin");
        var atText = diagnosticTimeText(item.at, tr, Date.now());
        var clockText = diagnosticClockText(item.at);
        var timeText = clockText && atText ? clockText + " \u00b7 " + atText : (clockText || atText);
        var detail = typeof item.detail === "string" ? item.detail : "";
        var preview = open ? "" : diagnosticPreview(detail, 2, 220);
        var detailKey = itemKey + ":detail";
        var detailCopy = copyState && copyState.key === detailKey ? copyState : null;
        var fixes = diagnosticFixes(item);
        var tone = item.severity === "error" ? "danger" : "neutral";
        var severityText = item.severity === "error" ? tr("diagnosticsSeverityError") : (item.severity === "warn" ? tr("diagnosticsSeverityWarn") : "");
        return h("div", { className: "diagItem", key: itemKey },
          h("div", { className: "diagHead" },
            item.severity === "error" ? h("span", { className: "diagDot", "aria-hidden": "true" }) : null,
            h("span", { className: "diagPlugin", title: plugin }, plugin),
            item.code ? h(Tag, { tone: tone }, String(item.code)) : null,
            severityText ? h("span", { className: "diagSeverity" }, severityText) : null,
            h("span", { className: "diagSpacer" }),
            timeText ? h("span", { className: "diagAt", title: String(item.at || "") }, timeText) : null
          ),
          item.title ? h("p", { className: "diagTitle" }, String(item.title)) : null,
          item.summary ? h("p", { className: "diagSummary" }, String(item.summary)) : null,
          preview
            ? h("pre", { className: "diagPreview", tabIndex: 0 }, preview)
            : null,
          detail
            ? h("div", null,
                h("button", {
                  type: "button",
                  className: "linkBtn diagToggle",
                  "aria-expanded": open ? "true" : "false",
                  onClick: function () {
                    toggleItem(itemKey);
                  }
                }, open ? tr("diagnosticsCollapse") : tr("diagnosticsDetail")),
                open ? h("pre", { className: "code", tabIndex: 0 }, detail) : null,
                open
                  ? h("div", { className: "cliRow" },
                      h(Button, {
                        variant: "ghost",
                        size: "sm",
                        onClick: function () {
                          doCopy(detail, detailKey);
                        }
                      }, detailCopy && detailCopy.ok ? tr("diagnosticsCopied") : tr("copy"))
                    )
                  : null
              )
            : null,
          fixes.length > 0
            ? h("div", { className: "diagFixes" },
                fixes.map(function (fix, fixIndex) {
                  return renderFix(item, fix, fixIndex);
                })
              )
            : h("p", { className: "diagNoFix" }, tr("diagnosticsNoFix"))
        );
      }

      var meta = diagnosticMetaText(props && props.meta, items.length, tr);

      return h(Modal, {
        open: true,
        onClose: props.onClose,
        title: tr("diagnosticsTitle"),
        closeLabel: tr("close"),
        footer: h("div", { className: "modalFooter" },
          h(Button, { variant: "primary", size: "sm", onClick: props.onClose }, tr("close"))
        )
      },
        h("div", { className: "modalBody" },
          items.length === 0
            ? h("p", { className: "modalText" }, tr("diagnosticsEmpty"))
            : h("div", { className: "diagList" },
                meta ? h("p", { className: "diagMeta" }, meta) : null,
                items.map(renderItem)
              )
        )
      );
    }

    function UpdateToast(props) {
      var tr = makeTranslator(props && props.t);
      var snapshotPair = React.useState(null);
      var snapshot = snapshotPair[0];
      var setSnapshot = snapshotPair[1];

      var visiblePair = React.useState(false);
      var visible = visiblePair[0];
      var setVisible = visiblePair[1];

      var dialogPair = React.useState(false);
      var dialogOpen = dialogPair[0];
      var setDialogOpen = dialogPair[1];

      var diagPair = React.useState(false);
      var diagOpen = diagPair[0];
      var setDiagOpen = diagPair[1];

      var diagFilterPair = React.useState("");
      var diagFilter = diagFilterPair[0];
      var setDiagFilter = diagFilterPair[1];

      function openDiagnosticsFor(plugin) {
        setDiagFilter(typeof plugin === "string" ? plugin : "");
        setDiagOpen(true);
      }

      var refreshPair = React.useState(0);
      var refreshToken = refreshPair[0];
      var bumpRefresh = refreshPair[1];

      React.useEffect(function () {
        var cancelled = false;
        var timer = null;
        var controller = null;
        var attempts = 0;

        function schedule() {
          if (cancelled) return;
          attempts += 1;
          if (attempts > TOAST_MAX_ATTEMPTS) return;
          timer = setTimeout(load, TOAST_RETRY_MS);
        }

        function load() {
          if (cancelled) return;
          controller = new AbortController();
          fetchState(controller.signal).then(function (value) {
            if (cancelled) return;
            setSnapshot(value);
            var updatable = updatableRowsOf(value);
            var errorItems = diagnosticErrorItems(value);
            if (updatable.length > 0 || errorItems.length > 0) {
              var bootId = value && typeof value.bootId === "string" ? value.bootId : "";
              if (!toastNotified(bootId)) {
                markToastNotified(bootId);
                setVisible(true);
              }
            }
            var diagnostics = diagnosticsOf(value);
            if (diagnostics === null) {
              schedule();
              return;
            }
            if (updatable.length === 0 && errorItems.length === 0 && !hasCheckedOnce(value)) schedule();
          }).catch(function (error) {
            if (cancelled || isAbortError(error)) return;
            schedule();
          });
        }

        load();

        return function () {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
          if (controller) {
            try {
              controller.abort();
            } catch (error) {
              /* already aborted */
            }
          }
        };
      }, [refreshToken]);

      React.useEffect(function () {
        if (!dialogOpen || typeof document === "undefined") return undefined;
        function onKeyDown(event) {
          if (event.key === "Escape") setDialogOpen(false);
        }
        document.addEventListener("keydown", onKeyDown, true);
        return function () {
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [dialogOpen]);

      var rows = updatableRowsOf(snapshot);
      var diagErrors = diagnosticErrorItems(snapshot);

      if (diagOpen) {
        return h(DiagnosticsDialog, {
          items: diagFilter ? diagnosticItemsFor(snapshot, diagFilter) : diagnosticItems(snapshot),
          pluginFilter: diagFilter,
          meta: diagnosticsOf(snapshot),
          t: props && props.t,
          onClose: function () {
            setDiagOpen(false);
            setDiagFilter("");
          },
          onChanged: function () {
            setDiagOpen(false);
            bumpRefresh(function (value) {
              return value + 1;
            });
          }
        });
      }

      if (dialogOpen) {
        return h("div", {
          className: "upgradeOverlay",
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) setDialogOpen(false);
          }
        },
          h("div", {
            className: "upgradePanel",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": tr("title"),
            tabIndex: -1,
            onMouseDown: function (event) {
              event.stopPropagation();
            }
          },
            h("div", { className: "upgradeHead" },
              h("h2", { className: "upgradeTitle" }, tr("title")),
              h("span", { className: "upgradeSpacer" }),
              h("button", {
                type: "button",
                className: "upgradeClose",
                "aria-label": tr("close"),
                title: tr("close"),
                onClick: function () {
                  setDialogOpen(false);
                }
              }, "×")
            ),
            h(UpdaterView, { compact: true, t: props && props.t })
          )
        );
      }

      if (!visible || (rows.length === 0 && diagErrors.length === 0)) return null;

      var bootId = snapshot && typeof snapshot.bootId === "string" ? snapshot.bootId : "";
      var shownRows = rows.slice(0, TOAST_MAX_ROWS);
      var diagCount = diagErrors.length;

      return h("div", { className: "toast" },
        h("div", {
          className: "toastCard",
          role: "button",
          tabIndex: 0,
          "aria-label": rows.length > 0 ? tr("toastHint") : tr("diagnosticsToastTitle", { n: String(diagnosticPluginCount(diagErrors)) }),
          onClick: function () {
            if (rows.length > 0) setDialogOpen(true);
          },
          onKeyDown: function (event) {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              if (rows.length > 0) setDialogOpen(true);
            }
          }
        },
          rows.length > 0
            ? h("div", { className: "toastHead" },
                h("span", { className: "toastTitle" }, tr("title")),
                h("span", { className: "toastCount" }, tr("toastCount", { n: rows.length }))
              )
            : null,
          h("button", {
            type: "button",
            className: "toastClose",
            "aria-label": tr("toastClose"),
            title: tr("toastClose"),
            onClick: function (event) {
              event.stopPropagation();
              markToastNotified(bootId);
              setVisible(false);
            }
          }, "×"),
          rows.length > 0
            ? h("ul", { className: "toastList" },
                shownRows.map(function (row) {
                  var from = typeof row.installedVersion === "string" && row.installedVersion ? row.installedVersion : "?";
                  var to = targetVersion(row) || "?";
                  var line = (row.name || "") + " " + tr("toastCurrent", { from: from, to: to });
                  return h("li", { className: "toastItem", key: String(row.name) + "@" + to, title: line },
                    h("span", { className: "toastName", title: String(row.name || "") }, row.name),
                    h("span", { className: "toastVer" }, tr("toastCurrent", { from: from, to: to }))
                  );
                })
              )
            : null,
          rows.length > TOAST_MAX_ROWS
            ? h("div", { className: "toastMore" }, tr("toastMore", { n: rows.length }))
            : null,
          diagCount > 0
            ? h("div", { className: "diagToastBox" },
                h("div", { className: "diagToastHead" },
                  h("span", { className: "diagDot", "aria-hidden": "true" }),
                  h("span", { className: "diagToastTitle" }, tr("diagnosticsToastTitle", { n: String(diagnosticPluginCount(diagErrors)) }))
                ),
                h("ul", { className: "diagToastList" },
                  diagErrors.slice(0, TOAST_MAX_DIAG).map(function (item) {
                    var plugin = typeof item.plugin === "string" && item.plugin ? item.plugin : tr("diagnosticsUnknownPlugin");
                    var clock = diagnosticClockText(item.at);
                    return h("li", { key: "diag:" + plugin + ":" + String(item.id || item.code || "") },
                      h("button", {
                        type: "button",
                        className: "diagToastRow",
                        title: [plugin, item.code ? String(item.code) : "", clock].filter(Boolean).join(" \u00b7 "),
                        onClick: function (event) {
                          event.stopPropagation();
                          openDiagnosticsFor(plugin);
                        }
                      },
                        h("span", { className: "diagToastName" }, plugin),
                        h("span", { className: "diagToastMeta" },
                          item.code ? h("span", { className: "diagToastCode" }, String(item.code)) : null,
                          clock ? h("span", { className: "diagToastAt" }, clock) : null
                        )
                      )
                    );
                  })
                ),
                diagCount > TOAST_MAX_DIAG
                  ? h("div", { className: "toastMore" }, tr("toastDiagMore", { n: String(diagCount - TOAST_MAX_DIAG) }))
                  : null,
                h("button", {
                  type: "button",
                  className: "linkBtn diagToastAll",
                  onClick: function (event) {
                    event.stopPropagation();
                    openDiagnosticsFor("");
                  }
                }, tr("diagnosticsToastLine", { n: String(diagCount) }))
              )
            : null,
          rows.length > 0 ? h("div", { className: "toastHint" }, tr("toastHint")) : null
        )
      );
    }

    /* ------------------------------------------------------------------ */
    /* apply                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Register one slot entry.
     *
     * The normal path is `ctx.slots.inject(slotName, () => register(...))`:
     * the callback fires once the host has declared the slot. Some hosts and
     * test harnesses only record the injected factory without invoking it, so
     * a guarded direct registration is attempted as a fallback. The
     * `registered` flag keeps both paths from registering the entry twice.
     */
    function wireSlot(ctx, options, Component) {
      var registered = false;
      function doRegister() {
        if (registered) return undefined;
        var entry = ctx.slots.register(options, Component);
        registered = true;
        return entry;
      }
      try {
        if (ctx.slots && typeof ctx.slots.inject === "function") {
          ctx.slots.inject(options.name, doRegister);
        }
      } catch (error) {
        /* slot not declared yet — the inject callback will register later */
      }
      if (!registered) {
        try {
          doRegister();
        } catch (error) {
          /* slot not declared yet — harmless, inject keeps the callback */
        }
      }
    }

    function apply(ctx) {
      var context = ctx || {};
      var t = typeof context.locale === "object" && context.locale && typeof context.locale.bind === "function"
        ? context.locale.bind(NS)
        : function (key) {
            return key;
          };

      injectStyles();

      if (context.locale && typeof context.locale.register === "function") {
        var registerDictionaries = function () {
          return context.locale.register(NS, { zh: ZH, en: EN });
        };
        if (typeof context.effect === "function") {
          try {
            context.effect(registerDictionaries, PACKAGE_ID + ": dictionaries");
          } catch (error) {
            try {
              registerDictionaries();
            } catch (registerError) {
              /* locale registry unavailable */
            }
          }
        } else {
          try {
            registerDictionaries();
          } catch (registerError) {
            /* locale registry unavailable */
          }
        }
      }

      try {
        wireSlot(context, {
          name: "settings.section",
          id: "plugin-updater",
          order: 36,
          label: function () {
            return t("nav");
          },
          locale: NS,
          inject: function () {
            return {};
          }
        }, Section);
      } catch (error) {
        /* never break plugin loading because the settings section is absent */
      }

      try {
        wireSlot(context, {
          name: "settings.plugins.tab",
          id: "plugin-updater.tab",
          order: 61,
          label: function () {
            return t("tab");
          },
          locale: NS
        }, TabPanel);
      } catch (error) {
        /* never break plugin loading because the plugins tab is absent */
      }

      /* Frame-wide overlay (bottom-right update reminder). Absent on some
         hosts; registration failure must never break the settings slots. */
      try {
        wireSlot(context, {
          name: "shell.overlay",
          id: "plugin-updater-toast",
          order: 50,
          locale: NS
        }, UpdateToast);
      } catch (error) {
        /* overlay slot unavailable */
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
