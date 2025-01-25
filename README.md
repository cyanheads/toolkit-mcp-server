# toolkit-mcp-server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-1.4.0-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.0.1-blue.svg)]()
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-blue.svg)]()
[![GitHub](https://img.shields.io/github/stars/cyanheads/toolkit-mcp-server?style=social)](https://github.com/cyanheads/toolkit-mcp-server)

A Model Context Protocol server providing LLM Agents with system utilities and tools, including IP geolocation, network diagnostics, system monitoring, cryptographic operations, and QR code generation.

## Model Context Protocol

The Model Context Protocol (MCP) enables communication between:

- **Clients**: Claude Desktop, IDEs, and other MCP-compatible clients
- **Servers**: Tools and resources for task management and automation
- **LLM Agents**: AI models that leverage the server's capabilities

<a href="https://glama.ai/mcp/servers/wl3y2xyi4u"><img width="380" height="200" src="https://glama.ai/mcp/servers/wl3y2xyi4u/badge" alt="Toolkit Server MCP server" /></a>

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Tools](#tools)
- [Contributing](#contributing)
- [License](#license)

## Features

### Network & Geolocation
- IP geolocation with intelligent caching
- Network connectivity testing
- Ping and traceroute utilities
- Public IP detection
- Rate limiting (45 requests/minute)

### System Utilities
- System information retrieval
- Resource monitoring
- Load average tracking
- Network interface details

### Security Tools
- Cryptographic hash generation (MD5, SHA-1, SHA-256, SHA-512)
- Constant-time hash comparison
- UUID generation

### Generator Tools
- QR code generation
  - Terminal output
  - SVG format
  - Base64 encoded images

## Installation

```bash
# Using npm (recommended)
npm install @cyanheads/toolkit-mcp-server

# Or install from source
git clone git@github.com:cyanheads/toolkit-mcp-server.git
cd toolkit-mcp-server
npm install
npm run build
```

## Configuration

Add to your MCP client settings:

```json
{
  "mcpServers": {
    "toolkit": {
      "command": "node",
      "args": ["node_modules/@cyanheads/toolkit-mcp-server/build/index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

## Tools

### Network Operations
```typescript
// Get geolocation data
const geo = await mcp.use('toolkit-mcp-server', 'geolocate', {
  query: '8.8.8.8'
});

// Check connectivity
const conn = await mcp.use('toolkit-mcp-server', 'checkConnectivity', {
  host: 'example.com',
  port: 443
});
```

### System Operations
```typescript
// Get system information
const sysInfo = await mcp.use('toolkit-mcp-server', 'getSystemInfo', {});

// Get load average
const load = await mcp.use('toolkit-mcp-server', 'getLoadAverage', {});
```

### Security Operations
```typescript
// Generate hash
const hash = await mcp.use('toolkit-mcp-server', 'hashData', {
  input: 'test data',
  algorithm: 'sha256'
});

// Generate UUID
const uuid = await mcp.use('toolkit-mcp-server', 'generateUUID', {});
```

### Generator Operations
```typescript
// Generate QR code
const qr = await mcp.use('toolkit-mcp-server', 'generateQRCode', {
  data: 'https://example.com',
  type: 'svg'
});
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Apache License 2.0. See [LICENSE](LICENSE) for more information.

---

<div align="center">
Built with the Model Context Protocol
</div>
