// UUID 验证：你可以直接在这里写死，或者在 Netlify 环境变量中配置 UUID
const userID = Deno.env.get("UUID") || "d342d11e-d424-4583-b36e-524ab1f0afa4"; 

export default async (request, context) => {
  const upgradeHeader = request.headers.get("Upgrade");
  
  // 1. 如果不是 WebSocket 请求，直接返回普通的网页内容 (伪装)
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    // 允许通过特定的路径访问伪装静态站
    return context.next(); 
  }

  // 2. 升级 HTTP 连接为 WebSocket
  const { socket: ws, response } = Deno.upgradeWebSocket(request);

  ws.onopen = () => {
    console.log("WebSocket connected");
  };

  ws.onmessage = async (event) => {
    const data = event.data;
    if (!(data instanceof ArrayBuffer)) return;

    const buffer = new Uint8Array(data);
    
    // 3. VLESS 协议解析 (简化示意，提取目标地址和端口)
    // VLESS 头部格式: [1字节版本][16字节UUID][1字节附加信息长度][M字节附加信息][1字节指令][2字节端口][1字节地址类型][N字节地址]
    if (buffer.length < 24) return;
    
    const version = buffer[0];
    const incomingUUID = parseUUID(buffer.slice(1, 17));
    
    // 校验 UUID
    if (incomingUUID !== userID) {
      console.log("Invalid UUID");
      ws.close();
      return;
    }

    const optLength = buffer[17];
    let offset = 18 + optLength;
    const command = buffer[offset]; // 1=TCP, 2=UDP
    offset++;
    const port = (buffer[offset] << 8) | buffer[offset + 1];
    offset += 2;
    const addrType = buffer[offset];
    offset++;

    let targetAddress = "";
    if (addrType === 1) { // IPv4
      targetAddress = buffer.slice(offset, offset + 4).join(".");
      offset += 4;
    } else if (addrType === 2) { // 域名
      const domainLength = buffer[offset];
      offset++;
      targetAddress = new TextDecoder().decode(buffer.slice(offset, offset + domainLength));
      offset += domainLength;
    } else if (addrType === 3) { // IPv6
      // IPv6 解析逻辑省略
      offset += 16;
    }

    const payload = buffer.slice(offset);

    // 4. 建立与目标服务器的 TCP 连接 (Deno.connect)
    try {
      const tcpConn = await Deno.connect({ hostname: targetAddress, port: port });
      
      // 发送 VLESS 响应头 (版本 + 附加信息长度0)
      ws.send(new Uint8Array([version, 0])); 
      
      // 首次数据转发
      if (payload.length > 0) {
        await tcpConn.write(payload);
      }

      // 5. 双向流量转发
      // 将 TCP 数据转发回 WebSocket
      const pipeTcpToWs = async () => {
        const buf = new Uint8Array(32768);
        try {
          while (true) {
            const bytesRead = await tcpConn.read(buf);
            if (!bytesRead) break;
            ws.send(buf.slice(0, bytesRead));
          }
        } catch (e) {
          // console.error("TCP -> WS Error:", e);
        } finally {
          ws.close();
        }
      };

      // 将后续 WebSocket 数据转发到 TCP
      ws.onmessage = async (e) => {
        if (e.data instanceof ArrayBuffer) {
          try {
            await tcpConn.write(new Uint8Array(e.data));
          } catch (err) {
            ws.close();
          }
        }
      };

      pipeTcpToWs();

    } catch (err) {
      console.error(`Failed to connect to ${targetAddress}:${port}`);
      ws.close();
    }
  };

  ws.onerror = (e) => console.error("WebSocket Error:", e);

  return response;
};

// 辅助函数：将字节数组转换为标准 UUID 字符串
function parseUUID(bytes) {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}