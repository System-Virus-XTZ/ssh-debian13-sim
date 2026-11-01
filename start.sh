#!/bin/bash
# anxi-ssh-game 启动脚本
# 用法：./start.sh          后台启动
#       ./start.sh stop     停止
#       ./start.sh status   查看状态

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="/tmp/anxi-ssh-game.pid"
LOGFILE="/tmp/anxi-ssh-game.log"
PORT="${PORT:-8822}"

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已经在跑了 (pid $(cat "$PIDFILE"))"
      exit 0
    fi

    # 首次运行需要生成主机密钥
    if [ ! -f "$DIR/keys/host_key" ]; then
      echo "生成主机密钥..."
      mkdir -p "$DIR/keys"
      ssh-keygen -t ed25519 -f "$DIR/keys/host_key" -N '' -C 'anxi-ssh-game'
    fi

    cd "$DIR"
    ( setsid node src/server.js < /dev/null > "$LOGFILE" 2>&1 & echo $! > "$PIDFILE" )
    sleep 2

    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已启动，端口 $PORT"
      echo "日志: $LOGFILE"
      echo "连接: ssh 任意名字@<主机> -p $PORT"
    else
      echo "启动失败，看日志："
      cat "$LOGFILE"
      exit 1
    fi
    ;;

  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "已停止"
    else
      echo "没在跑"
    fi
    ;;

  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "运行中 (pid $(cat "$PIDFILE"))"
      timeout 2 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null \
        && echo "端口 $PORT 可连" || echo "端口 $PORT 连不上"
    else
      echo "没在跑"
    fi
    ;;

  *)
    echo "用法: $0 {start|stop|status}"
    exit 1
    ;;
esac
