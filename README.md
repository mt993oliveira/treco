# ControlFinance — Futebol Virtual Bet365/Betano

Sistema de coleta automática e análise histórica de jogos de futebol virtual da **Bet365** e **Betano**, com dashboard analítico em tempo real.

- **Stack**: Node.js · Express · SQL Server · Puppeteer · HTML/CSS/JS  
- **Domínio**: controlfinance.com.br  
- **Banco**: PRODUCAO (SQL Server local, `sa`)  
- **Porta**: 3000

---

## Estrutura do Projeto

```
/PRODUCAO
├── backend/
│   ├── server.js                   # Ponto de entrada — Express + coleta integrada
│   ├── scheduler.js                # Agendador standalone do coletor Betano
│   ├── scheduler-bet365.js         # Agendador standalone do coletor Bet365
│   ├── routes/
│   │   ├── auth.js                 # Autenticação JWT (/api/auth/*)
│   │   ├── bet365-api.js           # API Bet365 (/api/bet365/*)
│   │   ├── betano-api.js           # API Betano (/api/betano/*)
│   │   ├── transactions.js         # Transações financeiras
│   │   ├── users.js                # Gestão de usuários
│   │   ├── dados.js                # Dados financeiros
│   │   ├── health.js               # Health check
│   │   └── monitoring.js          # Monitoramento de sistema
│   ├── services/
│   │   ├── bet365-coletor.js       # Scraper Bet365 (Puppeteer + Edge)
│   │   └── betano-coletor.js       # Scraper Betano (Puppeteer)
│   ├── middleware/
│   │   ├── auth.js                 # Verificação JWT
│   │   ├── security.js             # Helmet, rate-limit, CORS
│   │   └── metrics.js              # Métricas de requisição
│   ├── models/
│   │   ├── user.js
│   │   └── transaction.js
│   ├── utils/
│   │   ├── logger.js               # Winston
│   │   ├── cache.js                # Cache in-memory
│   │   ├── auditLogger.js
│   │   ├── backup.js
│   │   ├── betano-utils.js
│   │   └── team-mapping.js
│   └── migrations/                 # Scripts de criação de tabelas (Node)
├── frontend/
│   ├── portifolio.html             # Página inicial (rota padrão "/")
│   ├── index.html                  # Dashboard financeiro
│   ├── bet365-historico.html       # Tabela Histórica + Análise Bet365 ← PRINCIPAL
│   ├── betano-historico.html       # Histórico Betano
│   └── images/
│       └── favicon.svg
├── SETUP_BANCO.sql                 # Cria todas as tabelas do zero
├── testar-bet365.js                # Teste do coletor sem salvar no banco
├── iniciar-servidor.bat            # Inicia servidor + coletor integrado
├── iniciar-coletor-bet365.bat      # Inicia só o coletor Bet365
├── iniciar-coletor.bat             # Inicia só o coletor Betano
├── parar-tudo.bat                  # Encerra todos os processos Node
├── .env                            # Variáveis de ambiente (NÃO versionar)
├── .env.example                    # Template de configuração
└── package.json
```

---

## Configuração Inicial

### 1. Pré-requisitos

- Node.js 18+
- SQL Server 2019+ (instância local em `127.0.0.1:1433`)
- Microsoft Edge instalado (para o scraper Bet365 com perfil de usuário)

### 2. Instalar dependências

```bash
npm install
```

### 3. Configurar o banco

Execute o script abaixo no SQL Server Management Studio ou via `sqlcmd`:

```bash
sqlcmd -S 127.0.0.1 -U sa -P sua_senha -i SETUP_BANCO.sql
```

### 4. Configurar variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```env
NODE_ENV=production
PORT=3000

# SQL Server
DB_USER=sa
DB_PASSWORD=sua_senha
DB_SERVER=127.0.0.1
DB_NAME=PRODUCAO
DB_PORT=1433
DB_ENCRYPT=false
DB_TRUST_CERT=true

# JWT
JWT_SECRET=sua_chave_secreta_longa

# Betano
BETANO_USERNAME=seu_usuario
BETANO_PASSWORD=sua_senha
BETANO_INTERVALO=1
BETANO_AGENDADOR_ATIVADO=true

# Bet365
BET365_USERNAME=seu_usuario
BET365_PASSWORD=sua_senha
BET365_BASE_URL=https://www.bet365.bet.br/#/AVR/B146/R%5E1/
BET365_HEADLESS=false
BET365_INTERVALO=1
BET365_AGENDADOR_ATIVADO=true

# CORS (produção)
CORS_ORIGIN=https://controlfinance.com.br
```

---

## Executando o Sistema

```bash
# Desenvolvimento (com nodemon)
npm run dev

# Produção
npm start
# ou
iniciar-servidor.bat
```

O servidor inicia na porta 3000 e automaticamente:
- Inicializa o pool SQL Server
- Inicia o coletor Bet365 (a cada 1 min)
- Inicia o coletor Betano (a cada 1 min)

---

## Banco de Dados

### Tabelas Bet365

| Tabela | Descrição |
|--------|-----------|
| `bet365_eventos` | Eventos agendados (próximos jogos + odds ao vivo) |
| `bet365_mercados` | Mercados de aposta por evento |
| `bet365_odds` | Odds por seleção/mercado |
| `bet365_historico_partidas` | Resultados finais com placar e odds |

### Tabelas Betano

| Tabela | Descrição |
|--------|-----------|
| `betano_eventos` | Eventos em tempo real |
| `betano_mercados` | Mercados de apostas |
| `betano_odds` | Odds por seleção |
| `betano_historico_partidas` | Resultados finais |
| `betano_historico_odds` | Variação histórica das odds |
| `betano_estatisticas_tempo_real` | Stats ao vivo |
| `betano_log_coleta` | Log de cada ciclo de coleta |

### Tabelas Financeiras

| Tabela | Descrição |
|--------|-----------|
| `users` | Usuários do sistema |
| `transactions` | Transações financeiras |
| `profiles` | Perfis de usuário |
| `audit_logs` | Auditoria de ações |

---

## API — Endpoints Bet365

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/bet365/eventos` | Próximos eventos agendados com odds |
| GET | `/api/bet365/ao-vivo` | Evento em andamento no momento |
| GET | `/api/bet365/historico-partidas` | Resultados recentes (últimas 24h) |
| GET | `/api/bet365/historico-tabela?horas=N` | Tabela histórica (padrão 24h) |
| GET | `/api/bet365/ligas` | Ligas com contagem de partidas |
| GET | `/api/bet365/stats` | Estatísticas gerais |
| GET | `/api/bet365/sugestoes` | Sugestões baseadas em histórico |
| GET | `/api/bet365/estatisticas-avancadas` | Heatmap de placar + performance por liga |
| GET | `/api/bet365/diagnostico` | Diagnóstico do coletor e banco |
| POST | `/api/bet365/buscar-resultados` | Força nova coleta de resultados |

## API — Endpoints Betano

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/betano/eventos` | Eventos ativos |
| GET | `/api/betano/probabilidades/:id` | Análise head-to-head |
| GET | `/api/betano/historico-tabela` | Todos os resultados |
| GET | `/api/betano/sugestoes` | Sugestões por liga |
| GET | `/api/betano/ligas` | Ligas disponíveis |
| GET | `/api/betano/log-coleta` | Status das coletas recentes |

## API — Autenticação

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/login` | Login (retorna JWT) |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Dados do usuário autenticado |

---

## Ligas Bet365 (Futebol Virtual)

O sistema coleta e exibe **4 ligas canônicas**. Aliases de nomes antigos são normalizados automaticamente:

| Nome Exibido | Aliases Aceitos |
|---|---|
| Copa do Mundo | World Cup |
| Euro Cup | Euro Cup |
| Premier League | Premiership |
| Super Liga Sul-Americana | South American Super League, Super League |

---

## Fusos Horários — Comportamento Crítico

> **Atenção**: o futebol virtual da Bet365 Brasil exibe horários em **UTC+1** (não BRT).

### Coletor (`bet365-coletor.js`)

O coletor extrai o horário do jogo da página Bet365 (ex: `14:52`) e armazena como:

```js
Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm)
```

A lógica de "é ontem ou hoje" usa **buffer de 90 minutos** (suficiente para acomodar o UTC+1 do Bet365):

```js
if (ms > Date.now() + 90 * 60000) ms -= 86400000; // só subtrai 1 dia se >90min no futuro
```

### Frontend (`bet365-historico.html`)

A grade "Tabela Histórica" usa `agora = Date.now() + 1h` para que o horário atual da grade bata com o UTC+1 do Bet365:

```js
const BET365_OFFSET_MS = 1 * 3600 * 1000;          // UTC+1
const agora = new Date(Date.now() + BET365_OFFSET_MS);
```

**Resultado**: um jogo às `14:52` no Bet365 aparece na linha `14:xx` e coluna `:52` da grade.

---

## Coleta — Ciclo de Vida

```
server.js inicializa
  └─ Bet365Coletor.iniciar()
       ├─ iniciarBrowser()        — abre Edge com perfil salvo (sem re-login)
       ├─ coletarEventos()        — captura próximos jogos + odds → bet365_eventos
       ├─ coletarResultados()     — captura resultados recentes → bet365_historico_partidas
       └─ agenda próxima coleta   — intervalo: BET365_INTERVALO minutos (padrão 1)
```

O coletor usa **IDs determinísticos (FNV-1a 32-bit)** baseados em `liga|timeCasa|timeFora|horario`, evitando duplicatas via MERGE no banco.

---

## Testando o Coletor

Para testar o coletor Bet365 **sem salvar nada no banco**:

```bash
node testar-bet365.js
```

---

## Scripts Disponíveis

| Comando | Descrição |
|---------|-----------|
| `npm start` | Produção — `node backend/server.js` |
| `npm run dev` | Desenvolvimento — `nodemon backend/server.js` |
| `npm run migrate` | Executa migrations do banco |
| `iniciar-servidor.bat` | Inicia servidor em background |
| `iniciar-coletor-bet365.bat` | Inicia só o coletor Bet365 |
| `iniciar-coletor.bat` | Inicia só o coletor Betano |
| `parar-tudo.bat` | Encerra todos os processos Node.js |

---

## Segurança

- Autenticação via **JWT** (expiração configurável via `SESSION_TIMEOUT`)
- Senhas com **bcrypt** (`BCRYPT_SALT_ROUNDS=12`)
- Rate limiting: **2000 req/15min** por IP
- Headers de segurança via **Helmet**
- Sanitização de inputs contra XSS e NoSQL injection

---

## Deploy (VPS Locaweb)

O sistema está configurado para rodar em `vps62858.publiccloud.com.br` (IP: `191.252.186.245`).

O `CORS_ORIGIN` no `.env` deve incluir todos os domínios permitidos:

```env
CORS_ORIGIN=https://controlfinance.com.br,https://www.controlfinance.com.br,...
```
