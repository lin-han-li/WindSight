"""
WebSocket事件处理模块
处理SocketIO实时通信事件
"""
from flask import request
from flask_socketio import emit, join_room, leave_room
import time
import logging

logger = logging.getLogger(__name__)

# 全局变量（将从app传入）
client_subscriptions = {}  # {session_id: set of node_ids}
active_nodes = {}
NODE_TIMEOUT = 10


def init_socket_events(socketio, nodes):
    """初始化Socket事件处理器"""
    global active_nodes
    active_nodes = nodes
    
    @socketio.on('connect')
    def handle_connect():
        """客户端连接事件"""
        sid = request.sid
        client_subscriptions[sid] = set()
        logger.info(f"✅ 客户端连接: {sid}")
        
        # 发送当前所有节点的状态摘要（轻量级）
        node_status_list = []
        current_time = time.time()
        for node_id, node_data in active_nodes.items():
            if current_time - node_data['timestamp'] < NODE_TIMEOUT:
                node_status_list.append({
                    'node_id': node_id,
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
        node_id = data.get('node_id')
        
        if not node_id:
            emit('error', {'message': '缺少 node_id 参数'})
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
        node_id = data.get('node_id')
        
        if not node_id:
            return
        
        # 离开房间
        leave_room(f'node_{node_id}')
        
        # 移除订阅记录
        if sid in client_subscriptions and node_id in client_subscriptions[sid]:
            client_subscriptions[sid].remove(node_id)
            logger.info(f"📡 客户端 {sid} 取消订阅节点: {node_id}")

