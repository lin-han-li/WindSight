"""
WebSocket事件处理模块
处理SocketIO实时通信事件
"""
from flask import request
from flask_login import current_user
from flask_socketio import emit, join_room, leave_room
import time
import logging

from windsight.models import RegisteredNode
from windsight.routes.api import get_node_timeout_seconds

logger = logging.getLogger(__name__)

# 全局变量（将从app传入）
client_subscriptions = {}  # {session_id: set of node_ids}
active_nodes = {}


def _normalize_node_id(value) -> str:
    return str(value or "").strip().upper()


def _is_admin_user() -> bool:
    return bool(getattr(current_user, "is_authenticated", False) and getattr(current_user, "role", "") == "admin")


def _accessible_node_ids_for_socket() -> set[str] | None:
    if _is_admin_user():
        return None
    if not getattr(current_user, "is_authenticated", False):
        return set()
    rows = (
        RegisteredNode.query.filter_by(owner_user_id=current_user.id, is_active=True)
        .with_entities(RegisteredNode.node_id)
        .all()
    )
    return {_normalize_node_id(row[0]) for row in rows}


def _can_access_socket_node(node_id: str) -> bool:
    if _is_admin_user():
        return True
    if not getattr(current_user, "is_authenticated", False):
        return False
    return bool(
        RegisteredNode.query.filter_by(
            node_id=_normalize_node_id(node_id),
            owner_user_id=current_user.id,
            is_active=True,
        ).first()
    )


def init_socket_events(socketio, nodes):
    """初始化Socket事件处理器"""
    global active_nodes
    active_nodes = nodes
    
    @socketio.on('connect')
    def handle_connect():
        """客户端连接事件"""
        sid = request.sid
        if not getattr(current_user, "is_authenticated", False):
            logger.warning(f"拒绝未登录 WebSocket 连接: {sid}")
            return False

        client_subscriptions[sid] = set()
        logger.info(f"✅ 客户端连接: {sid}")
        
        # 发送当前所有节点的状态摘要（轻量级）
        node_status_list = []
        current_time = time.time()
        timeout_seconds = get_node_timeout_seconds()
        allowed_node_ids = _accessible_node_ids_for_socket()
        for node_id, node_data in active_nodes.items():
            normalized_node_id = _normalize_node_id(node_id)
            if allowed_node_ids is not None and normalized_node_id not in allowed_node_ids:
                continue
            if current_time - float(node_data.get('timestamp', 0)) < timeout_seconds:
                node_status_list.append({
                    'node_id': normalized_node_id,
                    'status': 'online',
                    'timestamp': node_data['timestamp']
                })
        
        emit('node_status_list', {'nodes': node_status_list})

    @socketio.on('disconnect')
    def handle_disconnect():
        """客户端断开连接事件"""
        sid = request.sid
        if sid in client_subscriptions:
            # 清理订阅记录
            subscribed_nodes = client_subscriptions.pop(sid)
            logger.info(f"❌ 客户端断开: {sid}, 取消订阅: {subscribed_nodes}")

    @socketio.on('subscribe_node')
    def handle_subscribe_node(data):
        """
        客户端订阅特定节点的实时数据（加入房间：node_<node_id>）

        说明：
        - WindSight 的实时数据由后端在 /api/upload 写库后，通过事件 node_data_update 推送给订阅者。
        - 历史回放由 HTTP 获取：/api/node_data
        - 这里不强制推送“最新一帧”，避免引入数据库查询与上下文依赖。
        """
        sid = request.sid
        node_id = _normalize_node_id((data or {}).get('node_id'))
        
        if not node_id:
            emit('error', {'message': '缺少 node_id 参数'})
            return

        if not _can_access_socket_node(node_id):
            emit('error', {'message': '无权订阅该节点', 'node_id': node_id})
            logger.warning(f"拒绝客户端 {sid} 订阅无权限节点: {node_id}")
            return
        
        # 加入房间（房间名为节点ID）
        join_room(f'node_{node_id}')
        
        # 记录订阅
        if sid not in client_subscriptions:
            client_subscriptions[sid] = set()
        client_subscriptions[sid].add(node_id)
        
        logger.info(f"📡 客户端 {sid} 订阅节点: {node_id}")
        emit('subscribed', {'node_id': node_id})

    @socketio.on('unsubscribe_node')
    def handle_unsubscribe_node(data):
        """客户端取消订阅特定节点"""
        sid = request.sid
        node_id = _normalize_node_id((data or {}).get('node_id'))
        
        if not node_id:
            return
        
        # 离开房间
        leave_room(f'node_{node_id}')
        
        # 移除订阅记录
        if sid in client_subscriptions and node_id in client_subscriptions[sid]:
            client_subscriptions[sid].remove(node_id)
            logger.info(f"📡 客户端 {sid} 取消订阅节点: {node_id}")

