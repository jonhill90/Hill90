# Twingate Remote Network for Hill90 VPS
resource "twingate_remote_network" "hill90_vps" {
  name = "hill90-vps"
}

# Twingate Connector for VPS
resource "twingate_connector" "hill90_connector" {
  name              = "hill90-vps-connector"
  remote_network_id = twingate_remote_network.hill90_vps.id
}

# Generate Connector Tokens (for docker-compose)
resource "twingate_connector_tokens" "hill90_tokens" {
  connector_id = twingate_connector.hill90_connector.id
}

# Twingate Resource: PostgreSQL Database
resource "twingate_resource" "postgres" {
  name              = "PostgreSQL"
  address           = "postgres"
  remote_network_id = twingate_remote_network.hill90_vps.id
}

# Twingate Resource: Auth Service
resource "twingate_resource" "auth" {
  name              = "Auth Service"
  address           = "auth"
  remote_network_id = twingate_remote_network.hill90_vps.id
}

# Twingate Resource: API Service (for internal debugging)
resource "twingate_resource" "api" {
  name              = "API Service"
  address           = "api"
  remote_network_id = twingate_remote_network.hill90_vps.id
}

# Twingate Resource: AI Service (for internal debugging)
resource "twingate_resource" "ai" {
  name              = "AI Service"
  address           = "ai"
  remote_network_id = twingate_remote_network.hill90_vps.id
}

# Twingate Resource: MCP Service (for internal debugging)
resource "twingate_resource" "mcp" {
  name              = "MCP Service"
  address           = "mcp"
  remote_network_id = twingate_remote_network.hill90_vps.id
}

# Twingate Resource: VPS Host SSH Access
resource "twingate_resource" "vps_host" {
  name              = "Hill90 VPS SSH"
  address           = "host.docker.internal"
  remote_network_id = twingate_remote_network.hill90_vps.id
}
