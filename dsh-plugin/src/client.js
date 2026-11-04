/**
 * dsh-motorscope — client half.
 *
 * Registers one left-sidebar panel row (the same slot the plugin manager uses)
 * and a full-width main panel that embeds the Windows MotorScope page. The
 * toolbar drives the host's /motorscope/api routes: open, close, restart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-motorscope',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var PANEL_ID = 'motorscope'
    var API = '/motorscope/api'

    var CSS = [
      '.ms-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-l1,#0f1013);color:var(--dsw-alias-label-primary,#e7e8ea);font-family:var(--ds-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:13px}',
      '.ms-dot{width:8px;height:8px;border-radius:50%;background:#6b7280;flex:none}',
      '.ms-dot.on{background:#2ecc71;box-shadow:0 0 7px rgba(46,204,113,.55)}',
      '.ms-dot.warn{background:#f5a623}',
      '.ms-status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0aa);white-space:nowrap}',
      '.ms-port{font-family:var(--ds-font-family-code,ui-monospace,monospace);color:#7c8798}',
      '.ms-lan-url{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;color:#7ee2a8;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ms-spacer{flex:1;min-width:8px}',
      '.ms-btn{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;gap:4px}',
      '.ms-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}',
      '.ms-btn:disabled{opacity:.45;cursor:default}',
      '.ms-btn.primary{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;color:#fff}',
      '.ms-btn.danger{color:#ff9b9b;border-color:rgba(220,70,70,.38)}',
      '.ms-btn.danger:hover{background:rgba(220,70,70,.14)}',
      '.ms-btn.lan-on{color:#7ee2a8;border-color:rgba(46,204,113,.42)}',
      '.ms-btn.lan-on:hover{background:rgba(46,204,113,.12)}',
      '.ms-bar-sep{width:1px;height:14px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.12));margin:0 2px;flex:none}',
      '.ms-body{position:relative;flex:1;min-height:0;background:#0b1220;overflow:hidden}',
      '.ms-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#0b1220}',
      '.ms-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:#93a0b4;background:radial-gradient(1200px 500px at 50% 0,rgba(77,107,254,.13),transparent 70%),#0b1220}',
      '.ms-empty b{font-size:15px;color:#e7e8ea;font-weight:600}',
      '.ms-empty p{margin:0;max-width:560px;line-height:1.7;font-size:12px;color:#8b97aa}',
      '.ms-args{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:#66738a;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:5px 8px}',
      '.ms-err{position:absolute;left:12px;right:12px;top:10px;z-index:3;padding:7px 10px;border-radius:6px;background:rgba(220,70,70,.16);border:1px solid rgba(220,70,70,.4);color:#ffb4b4;font-size:12px;line-height:1.5}',
      '.ms-veil{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(11,18,32,.86);color:#c7d0de;font-size:13px}',
      '.ms-spin{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.18);border-top-color:#4d6bfe;animation:ms-spin .8s linear infinite}',
      '@keyframes ms-spin{to{transform:rotate(360deg)}}',
      '.ms-foot{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));background:var(--dsw-alias-bg-l2,#15161a);font-size:11px;color:#6b7688;box-sizing:border-box;min-height:32px;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:none}',
      '.ms-foot::-webkit-scrollbar{display:none}',
    ].join('\n')

    // Shared state: the sidebar row keeps the running dot fresh even while the
    // panel is closed, and the panel reads the same snapshot when it returns.
    var shared = {
      snapshot: { loading: true },
      listeners: new Set(),
      timer: null,
      fast: false,
      paused: false,
      polling: false,
    }

    function emit(next) {
      if (next && next.ts && shared.snapshot && shared.snapshot.ts && next.ts < shared.snapshot.ts) return
      shared.snapshot = next
      shared.listeners.forEach(function (listener) {
        try { listener() } catch (cause) { /* one dead component must not stop the row */ }
      })
    }

    function getSnapshot() { return shared.snapshot }

    function schedulePolling() {
      if (shared.timer !== null) {
        clearInterval(shared.timer)
        shared.timer = null
      }
      if (shared.listeners.size === 0) return
      shared.timer = setInterval(refresh, shared.fast ? 3000 : 10000)
    }

    var visibilityBound = false
    function bindVisibility() {
      if (visibilityBound || typeof document === 'undefined') return
      visibilityBound = true
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refresh()
      })
    }

    function subscribe(listener) {
      shared.listeners.add(listener)
      bindVisibility()
      if (shared.snapshot.loading && !shared.polling) refresh()
      schedulePolling()
      return function () {
        shared.listeners.delete(listener)
        if (shared.listeners.size === 0) {
          clearInterval(shared.timer)
          shared.timer = null
        }
      }
    }

    function setFast(fast) {
      if (shared.fast === fast) return
      shared.fast = fast
      schedulePolling()
    }

    function refresh() {
      if (shared.polling || shared.paused) return Promise.resolve()
      if (typeof document !== 'undefined' && document.hidden) return Promise.resolve()
      shared.polling = true
      return fetch(API + '/state', { cache: 'no-store' })
        .then(function (response) { return response.json() })
        .then(function (payload) {
          if (payload && payload.ok !== false) {
            emit(Object.assign({ loading: false }, payload))
          } else {
            emit(Object.assign({}, shared.snapshot, { loading: false, ok: false }))
          }
        })
        .catch(function () {
          emit(Object.assign({}, shared.snapshot, { loading: false, ok: false }))
        })
        .then(function () { shared.polling = false })
    }

    function withLan(url, lanUrl) {
      if (!url || !lanUrl) return url || ''
      try {
        var parsed = new URL(url, window.location.href)
        parsed.searchParams.set('lan', lanUrl)
        return parsed.toString()
      } catch (cause) {
        return url
      }
    }

    function Icon(props) {
      var size = (props && props.size) || 16
      var state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      var running = Boolean(state && state.running)
      var healthy = Boolean(state && state.healthy)
      var color = running ? (healthy ? '#2ecc71' : '#f5a623') : '#6b7280'
      var title = running
        ? (healthy ? 'MotorScope 运行中' : 'MotorScope 启动中')
        : 'MotorScope 未运行'
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('title', null, title),
      h('path', { d: 'M2.5 14.5h4l2.2-8 3.6 12 2.6-9.2 1.9 5.2h4.7' }),
      h('circle', {
        cx: 19.4, cy: 19.4, r: 3.4, fill: color,
        stroke: 'var(--dsw-alias-bg-l1, #0f1013)', strokeWidth: 1.4,
      }))
    }

    function useMotorscope() {
      var state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      var [busy, setBusy] = React.useState('')
      var [error, setError] = React.useState('')
      var [reloadKey, setReloadKey] = React.useState(0)
      var [frameUrl, setFrameUrl] = React.useState('')
      var [lan, setLan] = React.useState({ loading: true, share: false, port80: false, enabled: false, url: '', url80: '' })
      var [lanBusy, setLanBusy] = React.useState(false)

      // The open panel polls faster than the sidebar row alone.
      React.useEffect(function () {
        setFast(true)
        refresh()
        return function () { setFast(false) }
      }, [])

      var act = React.useCallback(function (action) {
        setBusy(action)
        setError('')
        if (action === 'stop') setFrameUrl('')
        shared.paused = true
        return fetch(API + '/' + action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(function (response) { return response.json() })
          .then(function (payload) {
            var next = payload && payload.state ? payload.state : payload
            if (next && next.ok !== false) emit(Object.assign({ loading: false }, next))
            if (payload && payload.ok === false) setError(payload.error || '操作失败')
            else if (next && next.warning) setError(next.warning)
            if (action !== 'stop') setReloadKey(function (key) { return key + 1 })
          })
          .catch(function (cause) {
            setError(String((cause && cause.message) || cause))
          })
          .then(function () {
            shared.paused = false
            setBusy('')
            return refresh()
          })
      }, [])

      React.useEffect(function () {
        if (state.running && state.url) {
          var lanBase = lan.share ? (lan.port80 && lan.url80 ? lan.url80 : lan.url) : ''
          setFrameUrl(withLan(state.url, lanBase))
        }
      }, [state.running, state.url, lan.share, lan.port80, lan.url, lan.url80])

      React.useEffect(function () {
        var alive = true
        fetch(API + '/lan', { cache: 'no-store' })
          .then(function (response) { return response.json() })
          .then(function (payload) {
            if (alive && payload && payload.lan) setLan(Object.assign({ loading: false }, payload.lan))
          })
          .catch(function () {
            if (alive) setLan({ loading: false, share: false, port80: false, enabled: false, url: '', url80: '' })
          })
        return function () { alive = false }
      }, [])

      var lanAction = React.useCallback(function (path, reloadFrame) {
        setLanBusy(true)
        setError('')
        return fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(function (response) { return response.json() })
          .then(function (payload) {
            if (payload && payload.lan) setLan(Object.assign({ loading: false }, payload.lan))
            if (payload && payload.ok === false) setError(payload.error || '局域网操作失败')
            if (payload && payload.warning) setError(payload.warning)
            if (reloadFrame) setReloadKey(function (key) { return key + 1 })
          })
          .catch(function (cause) {
            setError(String((cause && cause.message) || cause))
          })
          .then(function () { setLanBusy(false) })
      }, [])

      var toggleShare = React.useCallback(function () {
        return lanAction('/lan/share/' + (lan.share ? 'off' : 'on'), true)
      }, [lan.share, lanAction])

      var toggle80 = React.useCallback(function () {
        return lanAction('/lan/port80/' + (lan.port80 ? 'off' : 'on'), false)
      }, [lan.port80, lanAction])

      return {
        state: state,
        busy: busy,
        error: error,
        act: act,
        reloadKey: reloadKey,
        frameUrl: frameUrl,
        reload: function () { setReloadKey(function (key) { return key + 1 }) },
        lan: lan,
        lanBusy: lanBusy,
        toggleShare: toggleShare,
        toggle80: toggle80,
      }
    }

    function Page() {
      var ms = useMotorscope()
      var state = ms.state || {}
      var running = Boolean(state.running)
      var healthy = Boolean(state.healthy)
      var busy = ms.busy
      var error = ms.error
      var url = ms.frameUrl || state.url || ''
      var args = Array.isArray(state.args) ? state.args.join(' ') : ''

      var statusText = state.loading
        ? '检测中…'
        : running
          ? (healthy ? '运行中' : (ms.frameUrl ? '连接不稳定' : '启动中…'))
          : '未运行'

      var busyText = busy === 'stop' ? '正在关闭旧窗口…'
        : busy === 'restart' ? '正在关闭旧窗口并重启…'
          : busy === 'start' ? '正在打开 MotorScope…'
            : ''

      var body
      if (ms.frameUrl) {
        body = h('iframe', {
          key: 'motorscope-frame-' + ms.reloadKey,
          className: 'ms-frame',
          src: ms.frameUrl,
          title: 'MotorScope',
          allow: 'clipboard-read; clipboard-write',
        })
      } else if (running) {
        body = h('div', { className: 'ms-empty' },
          h('div', { className: 'ms-spin' }),
          h('b', null, 'MotorScope 正在启动'),
          h('p', null, '端口 ' + (state.port || '…') + ' 还没有响应，正在等 /api/status 就绪。'),
          args ? h('div', { className: 'ms-args', title: args }, args) : null,
        )
      } else {
        body = h('div', { className: 'ms-empty' },
          h('b', null, 'MotorScope 未运行'),
          h('p', null, '点“打开”会启动 scope_server.py；如果还有旧的窗口/进程，会先整棵关掉再启动。'),
          h('button', { className: 'ms-btn primary', disabled: Boolean(busy), onClick: function () { ms.act('start') } },
            busy === 'start' ? '正在打开…' : '打开 MotorScope'),
          h('div', { className: 'ms-args', title: args }, args || '（还没有保存的启动参数）'),
        )
      }

      return h('div', { className: 'ms-root' },
        h('style', null, CSS),
        h('div', { className: 'ms-body' },
          body,
          error ? h('div', { className: 'ms-err' }, error) : null,
          busy ? h('div', { className: 'ms-veil' },
            h('div', { className: 'ms-spin' }),
            h('span', null, busyText),
          ) : null,
        ),
        h('div', { className: 'ms-foot', title: (args ? args + '  ' : '') + (state.project || '') },
            h('span', { className: 'ms-status' },
              h('span', { className: 'ms-dot' + (running ? (healthy ? ' on' : ' warn') : '') }),
              statusText,
              running && state.port ? h('span', { className: 'ms-port' }, ':' + state.port) : null,
            ),
            h('span', { className: 'ms-spacer' }),
            h('button', {
              className: 'ms-btn primary',
              disabled: Boolean(busy) || running,
              onClick: function () { ms.act('start') },
              title: '启动 MotorScope（先清理遗留实例）',
            }, '打开'),
            h('button', {
              className: 'ms-btn',
              disabled: Boolean(busy) || !running,
              onClick: function () { ms.act('restart') },
              title: '用同一组参数重启：关掉旧控制台窗口 → 重新启动',
            }, '重启'),
            running && ms.frameUrl ? h('button', {
              className: 'ms-btn', disabled: Boolean(busy), onClick: ms.reload, title: '只刷新页面，不重启进程',
            }, '刷新') : null,
            running && ms.frameUrl ? h('button', {
              className: 'ms-btn', onClick: function () { window.open(ms.frameUrl, '_blank', 'noopener') }, title: '在浏览器新窗口打开',
            }, '新窗口') : null,
            h('button', {
              className: 'ms-btn' + (ms.lan && ms.lan.share ? ' lan-on' : ''),
              disabled: Boolean(busy) || ms.lanBusy,
              onClick: ms.toggleShare,
              title: ms.lan && ms.lan.share
                ? '关闭局域网共享（共享地址 ' + (ms.lan.url || '') + '）'
                : '打开局域网共享（Windows 会弹防火墙提示，默认关闭）',
            }, ms.lanBusy ? '局域网…' : (ms.lan && ms.lan.share ? '共享：开' : '局域网共享')),
            h('button', {
              className: 'ms-btn' + (ms.lan && ms.lan.port80 ? ' lan-on' : ''),
              disabled: Boolean(busy) || ms.lanBusy || !(ms.lan && ms.lan.share),
              onClick: ms.toggle80,
              title: !(ms.lan && ms.lan.share)
                ? '先打开局域网共享'
                : (ms.lan.port80 ? '取消可选 80 端口绑定' : '可选：绑定 80 端口（需要管理员权限）'),
            }, ms.lan && ms.lan.port80 ? '80：开' : '80 端口'),
            ms.lan && ms.lan.share && (ms.lan.url80 || ms.lan.url)
              ? h('span', { className: 'ms-lan-url', title: '局域网共享地址' }, (ms.lan.url80 || ms.lan.url))
              : null,
            h('span', { className: 'ms-bar-sep' }),
            h('button', {
              className: 'ms-btn danger',
              disabled: Boolean(busy) || !running,
              onClick: function () { ms.act('stop') },
              title: '关闭 MotorScope 进程和它的控制台窗口（不会随页面切换触发）',
            }, '关闭'),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.slots.inject('main', function () {
          return ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, Page)
        })
      }, 'dsh-motorscope: main panel')

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 2,
            label: function () { return 'MotorScope' },
          }, Icon)
        })
      }, 'dsh-motorscope: sidebar row')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
