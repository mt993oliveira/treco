const express = require('express');
const router  = express.Router();
const sql     = require('mssql');

function requireAuthAdmin(req, res, next) {
    const u = req.sessionUser;
    if (!u) return res.status(401).json({ success: false, message: 'Não autenticado' });
    const t = (u.tipo || '').toLowerCase();
    if (t !== 'master' && t !== 'admin' && t !== 'administrador')
        return res.status(403).json({ success: false, message: 'Acesso negado' });
    next();
}

// GET /api/financeiro?mes=2026-06
router.get('/', requireAuthAdmin, async (req, res) => {
    try {
        const { mes } = req.query;
        const pool = await sql.connect();
        const r = pool.request();
        let where = '';
        if (mes) {
            r.input('mes', sql.NVarChar(7), mes);
            where = 'WHERE mes_ref = @mes';
        }
        const result = await r.query(`
            SELECT id, tipo, descricao, valor, mes_ref, data_criacao
            FROM financeiro_lancamentos
            ${where}
            ORDER BY data_criacao DESC
        `);
        const lancamentos = result.recordset;
        const receitas  = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + parseFloat(l.valor), 0);
        const despesas  = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + parseFloat(l.valor), 0);
        res.json({ success: true, data: lancamentos, totais: { receitas, despesas, saldo: receitas - despesas } });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /api/financeiro
router.post('/', requireAuthAdmin, express.json(), async (req, res) => {
    try {
        const { tipo, descricao, valor, mes_ref } = req.body;
        if (!tipo || !descricao || !valor || !mes_ref)
            return res.status(400).json({ success: false, message: 'Campos obrigatórios: tipo, descricao, valor, mes_ref' });
        if (!['receita','despesa'].includes(tipo))
            return res.status(400).json({ success: false, message: 'tipo deve ser receita ou despesa' });
        const pool = await sql.connect();
        const result = await pool.request()
            .input('tipo',      sql.NVarChar(10),  tipo)
            .input('descricao', sql.NVarChar(200), descricao.trim())
            .input('valor',     sql.Decimal(10,2), parseFloat(valor))
            .input('mes_ref',   sql.NVarChar(7),   mes_ref)
            .query(`
                INSERT INTO financeiro_lancamentos (tipo, descricao, valor, mes_ref)
                OUTPUT INSERTED.id, INSERTED.tipo, INSERTED.descricao, INSERTED.valor, INSERTED.mes_ref, INSERTED.data_criacao
                VALUES (@tipo, @descricao, @valor, @mes_ref)
            `);
        res.json({ success: true, data: result.recordset[0] });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /api/financeiro/:id
router.delete('/:id', requireAuthAdmin, async (req, res) => {
    try {
        const pool = await sql.connect();
        await pool.request()
            .input('id', sql.Int, parseInt(req.params.id))
            .query('DELETE FROM financeiro_lancamentos WHERE id = @id');
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /api/financeiro/meses — lista meses com lançamentos
router.get('/meses', requireAuthAdmin, async (req, res) => {
    try {
        const pool = await sql.connect();
        const r = await pool.request().query(`
            SELECT DISTINCT mes_ref FROM financeiro_lancamentos ORDER BY mes_ref DESC
        `);
        res.json({ success: true, data: r.recordset.map(r => r.mes_ref) });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
