# ControlFinance — RadarDaBet · Guia de Setup Completo

> Documento de referência para reinstalação do projeto em novo PC ou novo servidor.
> Atualizado em: 2026-05-21

---

## Arquitetura Geral

```
Windows Local
  └── Edge (porta 9222) ── Puppeteer ── bet365-coletor.js
  └── bet365-coletor-odds.js
  └── backend/server.js  →  conecta ao SQL Server remoto (76.13.174.51)

VPS Linux (Hostinger) — 76.13.174.51
  └── SQL Server (porta 1433)
  └── Node.js via PM2 → backend/server.js (BET365_AGENDADOR_ATIVADO=false)
  └── Nginx → proxy para porta 3000 → https://radardabet.com.br
```

**Regra de ouro:**
- Coletor Bet365 → roda APENAS no Windows local
- Site (frontend + API) → roda no servidor Linux via PM2
- Banco de dados → SQL Server no servidor Linux
- Código → editado no Windows, publicado via `git push`, aplicado no servidor via `git pull`

---

## 1. Windows Local — Pré-requisitos

### 1.1 Git
- Baixar em: https://git-scm.com/download/win
- Durante a instalação, manter opções padrão
- Após instalar, configurar identidade:
```bash
git config --global user.name "ControlFinance"
git config --global user.email "mt993.oliveira@gmail.com"
```

### 1.2 Node.js
- Baixar versão LTS em: https://nodejs.org
- Versão mínima recomendada: 18.x
- Verificar instalação:
```bash
node -v
npm -v
```

### 1.3 Microsoft Edge
- Já vem instalado no Windows 11
- Precisa estar na versão atualizada (verificar em edge://settings/help)
- O coletor usa o Edge com perfil isolado — não precisa de configuração adicional

### 1.4 Claude Code (opcional, para desenvolvimento)
```bash
npm install -g @anthropic-ai/claude-code
```

---

## 2. Windows Local — Clonar e Instalar o Projeto

```bash
git clone https://github.com/mt993oliveira/treco.git C:\PRODUCAO
cd C:\PRODUCAO
npm install
```

---

## 3. Windows Local — Arquivo .env

Criar o arquivo `C:\PRODUCAO\.env` com o conteúdo abaixo.
**Este arquivo NÃO vai para o GitHub (está no .gitignore) — precisa criar manualmente.**

```env
# =============================================
# BANCO DE DADOS (SQL Server no servidor Linux)
# =============================================
DB_SERVER=76.13.174.51
DB_USER=sa
DB_PASSWORD=SENHA_DO_SQLSERVER
DB_NAME=PRODUCAO
DB_PORT=1433

# =============================================
# SERVIDOR
# =============================================
PORT=3000
NODE_ENV=production

# =============================================
# COLETOR BET365
# =============================================
BET365_AGENDADOR_ATIVADO=true

# Credenciais Bet365 — suporta múltiplas contas com fallback automático
BET365_CONTAS=mt993oliveira:SENHA_BET365
# BET365_CONTAS=conta1:senha1,conta2:senha2

# =============================================
# TELEGRAM (alertas automáticos)
# =============================================
TELEGRAM_BOT_TOKEN=TOKEN_DO_BOT
TELEGRAM_CHAT_ID=ID_DO_CHAT

# =============================================
# KIRVANO (webhooks de pagamento)
# =============================================
KIRVANO_SECRET=SECRET_KIRVANO
```

> **Dica:** O arquivo `.env` do servidor Linux é diferente — `DB_SERVER=127.0.0.1` e `BET365_AGENDADOR_ATIVADO=false`.

---

## 4. Windows Local — Inicialização Manual

Executar o arquivo bat principal:
```
C:\PRODUCAO\iniciar-tudo.bat
```

O bat faz automaticamente:
1. `git pull` — atualiza o código
2. Abre o Edge já na URL do futebol virtual (porta 9222)
3. Aguarda 15 segundos para a página carregar
4. Inicia o Coletor 2 (odds)
5. Inicia o servidor principal (`npm start`)
6. O coletor detecta o estado de sessão e faz login automático na Bet365 se necessário

---

## 5. Windows Local — Inicialização Automática (ao ligar o PC)

### 5.1 Login automático do Windows (sem digitar senha)

Executar no PowerShell como Administrador:
```powershell
$RegPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $RegPath -Name "AutoAdminLogon"    -Value "1"
Set-ItemProperty -Path $RegPath -Name "DefaultUserName"   -Value "Administrador"
Set-ItemProperty -Path $RegPath -Name "DefaultDomainName" -Value $env:COMPUTERNAME
Set-ItemProperty -Path $RegPath -Name "DefaultPassword"   -Value "SENHA_DO_WINDOWS"
```

### 5.2 Agendador de Tarefas — rodar o bat ao fazer logon

Executar no PowerShell como Administrador:
```powershell
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/k "C:\PRODUCAO\iniciar-tudo.bat"' -WorkingDirectory 'C:\PRODUCAO'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'Administrador'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'ControlFinance-Bet365' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
```

Para remover a tarefa no futuro:
```powershell
Unregister-ScheduledTask -TaskName 'ControlFinance-Bet365' -Confirm:$false
```

**Fluxo completo após reinicialização do PC:**
```
PC liga → Windows loga automaticamente → Tarefa agendada dispara →
iniciar-tudo.bat abre Edge + coletor + servidor →
Coletor faz login automático na Bet365 → Coleta rodando
```

---

## 6. VPS Linux (Hostinger) — Informações do Servidor

| Item | Valor |
|------|-------|
| Provider | Hostinger VPS |
| OS | Ubuntu Linux |
| IP | 76.13.174.51 |
| Domínio | radardabet.com.br |
| Pasta do site | /var/www/radardabet |
| Usuário do site | mt993oliveira |
| Node.js | v18.19.1 |
| PM2 | 6.0.14 |
| Nginx | 1.24.0 |

### Acesso ao servidor
- **Operações do site** (git pull, pm2, npm): Remote Desktop (mstsc) → usuário `mt993oliveira`
- **Instalações do sistema** (apt, nginx, certbot): Terminal web do painel Hostinger → usuário `root`

---

## 7. VPS Linux — Setup Inicial (do zero)

### 7.1 Instalações do sistema (como root)
```bash
# Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# PM2
npm install -g pm2

# Nginx
apt install -y nginx

# Certbot (SSL)
apt install -y certbot python3-certbot-nginx
```

### 7.2 Criar pasta do site (como root)
```bash
mkdir -p /var/www/radardabet
chown mt993oliveira:mt993oliveira /var/www/radardabet
```

### 7.3 Clonar o projeto (como mt993oliveira)
```bash
cd /var/www/radardabet
git clone https://github.com/mt993oliveira/treco.git .
npm install --omit=dev
```

### 7.4 Criar .env do servidor (como root, depois ajustar dono)
```bash
nano /var/www/radardabet/.env
chown mt993oliveira:mt993oliveira /var/www/radardabet/.env
```

Conteúdo do `.env` do servidor:
```env
DB_SERVER=127.0.0.1
DB_USER=sa
DB_PASSWORD=SENHA_DO_SQLSERVER
DB_NAME=PRODUCAO
DB_PORT=1433
PORT=3000
NODE_ENV=production
BET365_AGENDADOR_ATIVADO=false
TELEGRAM_BOT_TOKEN=TOKEN_DO_BOT
TELEGRAM_CHAT_ID=ID_DO_CHAT
KIRVANO_SECRET=SECRET_KIRVANO
```

### 7.5 Configurar Nginx (como root)
```bash
nano /etc/nginx/sites-available/radardabet
```

Conteúdo:
```nginx
server {
    listen 80;
    server_name radardabet.com.br www.radardabet.com.br;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/radardabet /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### 7.6 SSL com Let's Encrypt (como root)
```bash
certbot --nginx -d radardabet.com.br -d www.radardabet.com.br
```

### 7.7 Subir com PM2 (como mt993oliveira)
```bash
cd /var/www/radardabet
pm2 start backend/server.js --name radardabet
pm2 save
pm2 startup
```

O `pm2 startup` gera um comando — copiar e rodar como root:
```bash
sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u mt993oliveira --hp /home/mt993oliveira
```

### 7.8 DNS na Hostinger
Painel → Domínios → DNS/Nameservers → Gerenciar registros DNS:

| Tipo | Nome | Conteúdo | TTL |
|------|------|----------|-----|
| A | @ | 76.13.174.51 | 60 |
| CNAME | www | radardabet.com.br | 300 |

---

## 8. Atualização do Código (dia a dia)

### Windows — após alterar o código:
```bash
git add arquivo-alterado.js
git commit -m "descrição da alteração"
git push origin master
```

O `iniciar-tudo.bat` já faz `git pull` automaticamente ao iniciar.

### Servidor Linux — aplicar atualização:
```bash
cd /var/www/radardabet && git pull origin master && pm2 restart radardabet
```

---

## 9. Comandos Úteis

### PM2 (servidor Linux, como mt993oliveira)
```bash
pm2 status                   # ver se está online
pm2 logs radardabet          # logs em tempo real
pm2 restart radardabet       # reiniciar após atualização
pm2 stop radardabet          # parar
pm2 save                     # salvar lista de processos
```

### Git
```bash
git status                   # ver arquivos modificados
git log --oneline -10        # últimos 10 commits
git pull origin master       # puxar atualizações
```

### Verificar tarefa agendada (Windows PowerShell)
```powershell
Get-ScheduledTask -TaskName 'ControlFinance-Bet365'
```

### Verificar login automático (Windows PowerShell)
```powershell
$r = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Get-ItemProperty $r | Select-Object AutoAdminLogon, DefaultUserName
```

---

## 10. Estrutura de Arquivos Principais

```
C:\PRODUCAO\
├── iniciar-tudo.bat              # Inicialização completa (Edge + Coletor + Servidor)
├── .env                          # Variáveis de ambiente (NÃO vai pro GitHub)
├── backend/
│   ├── server.js                 # Servidor principal (Express + autenticação + API)
│   ├── routes/
│   │   ├── bet365-api.js         # API de dados Bet365 + config do sistema
│   │   └── kirvano.js            # Webhooks de pagamento Kirvano
│   └── services/
│       ├── bet365-coletor.js     # Coletor principal (resultados + mercados)
│       ├── bet365-coletor-odds.js # Coletor 2 (odds pré-jogo)
│       └── alertas.js            # Disparo de alertas Telegram
└── frontend/
    └── radardabet.html           # Frontend completo (SPA)
```

---

## 11. Comportamento do Coletor Bet365

- Roda a cada 10 segundos (configurável)
- Conecta ao Edge via Puppeteer na porta 9222
- Verifica sessão **antes** de qualquer reload — se Login visível, faz login automático
- Credenciais do `.env` (`BET365_CONTAS`) — suporta múltiplas contas com fallback
- Notifica via Telegram quando: sessão expira, login falha, conta pede verificação SMS/email
- Após reinicialização do PC: Edge abre automático na URL correta + coletor faz login se necessário

---

## 12. Senhas e Credenciais (guardar em local seguro)

> Não deixar este arquivo com senhas reais no GitHub. Use este como referência de quais credenciais existem.

| Credencial | Onde usar |
|-----------|-----------|
| Senha Windows (`Administrador`) | Login automático + acesso ao PC |
| Senha SQL Server (`sa`) | `.env` campo `DB_PASSWORD` |
| Credenciais Bet365 | `.env` campo `BET365_CONTAS` |
| Token Telegram Bot | `.env` campo `TELEGRAM_BOT_TOKEN` |
| Chat ID Telegram | `.env` campo `TELEGRAM_CHAT_ID` |
| Secret Kirvano | `.env` campo `KIRVANO_SECRET` |
| Senha VPS mt993oliveira | Acesso Remote Desktop ao servidor |
