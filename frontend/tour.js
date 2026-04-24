/**
 * Radardabet — Tour de Onboarding
 * Exibido automaticamente no primeiro acesso de cada usuário.
 * Para reiniciar o tour: localStorage.removeItem('radarx_tour_done')
 */
(function () {
    'use strict';

    const TOUR_KEY  = 'radarx_tour_done';
    const ACCENT    = '#1fcc59';
    const ACCENT2   = '#0ea5e9';
    const ACCENT3   = '#7c3aed';

    // =====================================================================
    // PASSOS DO TOUR
    // =====================================================================
    function getSteps(isMaster) {
        const common = [
            {
                sel: '#liga-tabs',
                title: 'Selecione a Liga',
                desc: 'Clique na aba da liga que deseja analisar. Os dados são atualizados automaticamente a cada 2 minutos.',
                pos: 'bottom'
            },
            {
                sel: '#view-analise',
                title: 'Visões do Painel',
                desc: 'Alterne entre <b style="color:#f1f5f9">Análise &amp; Sugestões</b>, <b style="color:#f1f5f9">Tabela Histórica</b> e <b style="color:#f1f5f9">Clubes</b> para diferentes perspectivas dos dados.',
                pos: 'bottom'
            },
            {
                sel: '#analise-cards',
                title: 'Cards de Liga',
                desc: 'Resumo rápido com percentual de ocorrência Over, tendência e dados dos últimos jogos. Clique em um card para ver detalhes.',
                pos: 'bottom'
            },
            {
                sel: '#heatmap-ia-section',
                title: 'Heatmap + Sugestões IA',
                desc: '<span style="color:#4ade80">Verde = vitória</span>, <span style="color:#f87171">vermelho = derrota</span>, <span style="color:#a5b4fc">roxo = empate</span>. O algoritmo aponta os melhores momentos para entrar.',
                pos: 'top'
            },
            {
                sel: '#user-menu-wrap',
                title: 'Seu Perfil',
                desc: 'Clique aqui para acessar suas configurações, alterar sua senha e, se for administrador, gerenciar os usuários da plataforma.',
                pos: 'bottom-left'
            }
        ];

        if (isMaster) {
            common.push(
                {
                    sel: '#view-diagnostico',
                    title: 'Diagnóstico do Sistema',
                    desc: 'Monitor exclusivo para Master: veja o status dos coletores, logs em tempo real e force atualizações manualmente.',
                    pos: 'bottom'
                },
                {
                    sel: null,
                    title: 'Gerenciar Usuários',
                    desc: 'No menu do seu perfil (canto superior direito), clique em <b style="color:#f1f5f9">"Gerenciar Usuários"</b> para criar, editar, definir licenças e controlar o acesso de todos os clientes.',
                    pos: 'center',
                    info: true
                }
            );
        }

        return common;
    }

    // =====================================================================
    // ESTADO
    // =====================================================================
    var steps = [], cur = 0;
    var hlEl = null, ttEl = null;

    // =====================================================================
    // INICIALIZAÇÃO
    // =====================================================================
    function init() {
        if (localStorage.getItem(TOUR_KEY)) return;

        var user;
        try { user = JSON.parse(localStorage.getItem('currentUser')); } catch (e) { return; }
        if (!user) return;

        steps = getSteps(user.TipoUsuario === 'master');

        // Aguarda um momento para a página carregar o conteúdo dinâmico
        setTimeout(function () { showWelcome(user); }, 2000);
    }

    // =====================================================================
    // MODAL DE BOAS-VINDAS
    // =====================================================================
    function showWelcome(user) {
        injectStyles();

        var nome = user.NomeCompleto || user.NomeUsuario || 'usuário';
        var ov = mk('div', 'tour-welcome-ov', {
            position: 'fixed', inset: '0', background: 'rgba(0,0,0,.82)',
            zIndex: '99990', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontFamily: "'Inter',system-ui,sans-serif",
            animation: 'tourFadeIn .3s ease'
        });

        ov.innerHTML = '\
<div style="background:#0f172a;border:1px solid #1e293b;border-radius:14px;\
  padding:28px 32px;max-width:400px;width:90%;text-align:center;\
  animation:tourSlideUp .4s ease;box-shadow:0 20px 60px rgba(0,0,0,.65)">\
  <div style="width:54px;height:54px;border-radius:50%;background:rgba(31,204,89,.12);\
    border:2px solid rgba(31,204,89,.3);display:flex;align-items:center;\
    justify-content:center;margin:0 auto 14px;font-size:22px">👋</div>\
  <h2 style="font-size:18px;font-weight:800;color:#f1f5f9;margin-bottom:8px">Olá, ' + nome + '!</h2>\
  <p style="font-size:13px;color:#64748b;line-height:1.65;margin-bottom:22px">\
    Bem-vindo ao <b style="color:' + ACCENT + '">Radardabet</b>. Gostaria de fazer um tour rápido\
    pelo painel e conhecer todas as funcionalidades?\
  </p>\
  <div style="display:flex;gap:10px;justify-content:center">\
    <button id="tour-btn-skip" style="padding:10px 18px;border-radius:7px;background:#1e293b;\
      border:1px solid #334155;color:#94a3b8;font-size:13px;font-weight:600;cursor:pointer">Pular</button>\
    <button id="tour-btn-start" style="padding:10px 22px;border-radius:7px;background:' + ACCENT + ';\
      border:none;color:#000;font-size:13px;font-weight:700;cursor:pointer">Iniciar Tour →</button>\
  </div>\
</div>';

        document.body.appendChild(ov);

        document.getElementById('tour-btn-skip').onclick = function () {
            ov.remove();
            localStorage.setItem(TOUR_KEY, '1');
        };
        document.getElementById('tour-btn-start').onclick = function () {
            ov.remove();
            startTour();
        };
    }

    // =====================================================================
    // INICIAR TOUR
    // =====================================================================
    function startTour() {
        // Destaque (spotlight)
        hlEl = mk('div', 'tour-highlight', {
            position: 'fixed', pointerEvents: 'none', zIndex: '99991',
            border: '2px solid ' + ACCENT, borderRadius: '8px',
            boxShadow: '0 0 0 9999px rgba(0,0,0,.78), 0 0 24px rgba(31,204,89,.35)',
            transition: 'all .35s cubic-bezier(.4,0,.2,1)',
            opacity: '0'
        });
        document.body.appendChild(hlEl);

        // Tooltip
        ttEl = mk('div', 'tour-tooltip', {
            position: 'fixed', zIndex: '99992',
            background: '#0f172a', border: '1px solid #1e293b',
            borderRadius: '10px', padding: '16px',
            maxWidth: '300px', width: '88vw',
            fontFamily: "'Inter',system-ui,sans-serif",
            boxShadow: '0 8px 32px rgba(0,0,0,.65)',
            transition: 'top .3s ease, left .3s ease, transform .3s ease'
        });
        document.body.appendChild(ttEl);

        cur = 0;
        showStep(cur);
    }

    // =====================================================================
    // EXIBIR PASSO
    // =====================================================================
    function showStep(i) {
        var step = steps[i];
        var isMobile = window.innerWidth < 640;

        // Progresso visual
        var barHtml = steps.map(function (_, j) {
            return '<div style="height:2px;flex:1;border-radius:2px;background:' +
                (j <= i ? ACCENT : '#1e293b') + ';transition:background .3s"></div>';
        }).join('');

        var prevBtn = i > 0
            ? '<button onclick="window.__tourPrev()" style="padding:7px 14px;border-radius:6px;\
               background:#1e293b;border:1px solid #334155;color:#e2e8f0;font-size:12px;\
               font-weight:600;cursor:pointer">← Anterior</button>'
            : '';

        var nextLabel = i === steps.length - 1 ? 'Concluir ✓' : 'Próximo →';

        ttEl.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">' +
            '  <span style="font-size:10px;color:' + ACCENT + ';font-weight:700;text-transform:uppercase;letter-spacing:.06em">' +
            (i + 1) + ' de ' + steps.length + '</span>' +
            '  <button onclick="window.__tourClose()" style="background:none;border:none;color:#64748b;\
               font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1">✕</button>' +
            '</div>' +
            '<div style="display:flex;gap:3px;margin-bottom:12px">' + barHtml + '</div>' +
            '<h3 style="font-size:14px;font-weight:700;color:#f1f5f9;margin-bottom:6px">' + step.title + '</h3>' +
            '<p style="font-size:12px;color:#94a3b8;line-height:1.65;margin-bottom:14px">' + step.desc + '</p>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end">' +
            prevBtn +
            '<button onclick="window.__tourNext()" style="padding:7px 18px;border-radius:6px;\
             background:' + ACCENT + ';border:none;color:#000;font-size:12px;\
             font-weight:700;cursor:pointer">' + nextLabel + '</button>' +
            '</div>';

        if (step.info || !step.sel) {
            hlEl.style.opacity = '0';
            posCenter();
            return;
        }

        var el = document.querySelector(step.sel);
        if (!el) {
            // Elemento não encontrado — pular este passo
            if (i < steps.length - 1) showStep(i + 1);
            else endTour();
            return;
        }

        // Rola para o elemento
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        setTimeout(function () {
            posOnEl(el, step.pos, isMobile);
        }, 120);
    }

    // =====================================================================
    // POSICIONAMENTO
    // =====================================================================
    function posOnEl(el, pos, isMobile) {
        var r   = el.getBoundingClientRect();
        var pad = 6;

        hlEl.style.opacity  = '1';
        hlEl.style.top      = (r.top  - pad) + 'px';
        hlEl.style.left     = (r.left - pad) + 'px';
        hlEl.style.width    = (r.width  + pad * 2) + 'px';
        hlEl.style.height   = (r.height + pad * 2) + 'px';

        if (isMobile) { posCenter(); return; }

        var tW = 300, tH = 180;
        var vW = window.innerWidth, vH = window.innerHeight;
        var top, left;

        if (pos === 'bottom' || pos === 'bottom-left') {
            top  = r.bottom + 14;
            left = pos === 'bottom-left' ? r.right - tW : r.left;
            if (top + tH > vH) top = r.top - tH - 14;
        } else if (pos === 'top') {
            top  = r.top - tH - 14;
            left = r.left;
            if (top < 8) top = r.bottom + 14;
        } else {
            posCenter(); return;
        }

        left = Math.max(12, Math.min(left, vW - tW - 12));

        ttEl.style.top       = top  + 'px';
        ttEl.style.left      = left + 'px';
        ttEl.style.transform = 'none';
    }

    function posCenter() {
        ttEl.style.top       = '50%';
        ttEl.style.left      = '50%';
        ttEl.style.transform = 'translate(-50%,-50%)';
    }

    // =====================================================================
    // ENCERRAR
    // =====================================================================
    function endTour() {
        if (hlEl) { hlEl.remove(); hlEl = null; }
        if (ttEl) { ttEl.remove(); ttEl = null; }
        localStorage.setItem(TOUR_KEY, '1');
        showToast('Tour concluído! Bom uso do Radardabet. 🎉');
    }

    function showToast(msg) {
        var t = mk('div', null, {
            position: 'fixed', bottom: '24px', left: '50%',
            transform: 'translateX(-50%)',
            background: '#0f172a', border: '1px solid ' + ACCENT,
            borderRadius: '8px', padding: '11px 20px',
            fontFamily: "'Inter',system-ui,sans-serif",
            fontSize: '13px', color: '#e2e8f0', zIndex: '99999',
            boxShadow: '0 4px 20px rgba(0,0,0,.5)',
            animation: 'tourFadeIn .3s ease', whiteSpace: 'nowrap'
        });
        t.innerHTML = '<span style="color:' + ACCENT + ';margin-right:6px">✓</span>' + msg;
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 3500);
    }

    // =====================================================================
    // CALLBACKS GLOBAIS (usados nos botões inline do tooltip)
    // =====================================================================
    window.__tourNext = function () {
        if (cur === steps.length - 1) { endTour(); }
        else { cur++; showStep(cur); }
    };
    window.__tourPrev = function () {
        if (cur > 0) { cur--; showStep(cur); }
    };
    window.__tourClose = function () { endTour(); };

    // Teclado
    document.addEventListener('keydown', function (e) {
        if (!ttEl) return;
        if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); window.__tourNext(); }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); window.__tourPrev(); }
        if (e.key === 'Escape')     window.__tourClose();
    });

    // Reposicionar ao redimensionar
    window.addEventListener('resize', function () {
        if (!ttEl || cur < 0) return;
        var step = steps[cur];
        if (step && !step.info && step.sel) {
            var el = document.querySelector(step.sel);
            if (el) posOnEl(el, step.pos, window.innerWidth < 640);
        }
    });

    // =====================================================================
    // HELPERS
    // =====================================================================
    function mk(tag, id, styles) {
        var el = document.createElement(tag);
        if (id) el.id = id;
        if (styles) Object.keys(styles).forEach(function (k) { el.style[k] = styles[k]; });
        return el;
    }

    function injectStyles() {
        if (document.getElementById('tour-styles')) return;
        var s = document.createElement('style');
        s.id = 'tour-styles';
        s.textContent =
            '@keyframes tourFadeIn{from{opacity:0}to{opacity:1}}' +
            '@keyframes tourSlideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}';
        document.head.appendChild(s);
    }

    // =====================================================================
    // BOOT
    // =====================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
