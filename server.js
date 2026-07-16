const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const app = express();

// Permite que o servidor entenda dados enviados em formato JSON
app.use(express.json());

// Libera o navegador (Vercel) a chamar este servidor (Render)
app.use(cors());

// ================================================================
// FIREBASE ADMIN — conecta o servidor ao mesmo banco usado pelo site
// ================================================================
let dbFirebase = null;

function obterDatabase() {
    if (dbFirebase) return dbFirebase;

    const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!base64) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 não configurado nas variáveis de ambiente do Render');
    }

    const jsonTexto = Buffer.from(base64, 'base64').toString('utf-8');
    const credenciais = JSON.parse(jsonTexto);

    if (!getApps().length) {
        initializeApp({
            credential: cert(credenciais),
            databaseURL: 'https://jd-show-premios-novo-default-rtdb.firebaseio.com'
        });
    }

    dbFirebase = getDatabase();
    return dbFirebase;
}

// ================================================================
// ROTAS ANTIGAS DE CARTELA (mantidas como estavam)
// ================================================================

// Nosso banco de dados temporário (salvo na memória do computador por enquanto)
let cartelasDoJogo = [];

// FUNÇÃO MATEMÁTICA: Gera 15 números únicos de 1 a 75
function gerarCartelaUnica() {
    const numeros = new Set();
    while (numeros.size < 15) {
        let numeroAleatorio = Math.floor(Math.random() * 75) + 1;
        numeros.add(numeroAleatorio);
    }
    return Array.from(numeros).sort((a, b) => a - b);
}

// ROTA 1: Criar a rodada com a quantidade de cartelas que você quiser
app.post('/admin/gerar-rodada', (req, res) => {
    const quantidade = req.body.quantidade;
    cartelasDoJogo = [];

    let idContador = 1;

    while (cartelasDoJogo.length < quantidade) {
        const novosNumeros = gerarCartelaUnica();
        const jaExiste = cartelasDoJogo.some(cartela =>
            JSON.stringify(cartela.numeros) === JSON.stringify(novosNumeros)
        );

        if (!jaExiste) {
            cartelasDoJogo.push({
                id: idContador++,
                numeros: novosNumeros,
                status: 'disponivel'
            });
        }
    }

    res.json({ mensagem: 'Sucesso! ' + quantidade + ' cartelas geradas sem nenhuma repetição.' });
});

// ROTA 2: Ver todas as cartelas que foram geradas
app.get('/admin/cartelas', (req, res) => {
    res.json(cartelasDoJogo);
});

// ================================================================
// ROTA NOVA 1: Criar cobrança Pix via Mercado Pago
// (o valor do Pix é sempre igual ao valor de crédito solicitado)
// ================================================================
app.post('/criar-pix', async (req, res) => {
    const { valor, nome, telefone, solicitacaoId } = req.body || {};

    const valorNumerico = parseFloat(valor);
    if (!valorNumerico || valorNumerico <= 0) {
        return res.status(400).json({ erro: 'Valor inválido' });
    }
    if (!nome || !telefone || !solicitacaoId) {
        return res.status(400).json({ erro: 'Dados incompletos (nome, telefone ou solicitacaoId faltando)' });
    }

    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
        console.error('MP_ACCESS_TOKEN não configurado nas variáveis de ambiente do Render');
        return res.status(500).json({ erro: 'Servidor não configurado corretamente. Fale com o administrador.' });
    }

    const telefoneNumeros = telefone.replace(/\D/g, '');
    const emailFicticio = `cliente${telefoneNumeros}@jdshowdepremios.com`;

    const corpoPagamento = {
        transaction_amount: Number(valorNumerico.toFixed(2)),
        description: `Créditos JD Show de Prêmios - ${nome}`,
        payment_method_id: 'pix',
        payer: {
            email: emailFicticio,
            first_name: nome.split(' ')[0] || nome
        },
        external_reference: solicitacaoId
    };

    try {
        const resposta = await fetch('https://api.mercadopago.com/v1/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'X-Idempotency-Key': solicitacaoId
            },
            body: JSON.stringify(corpoPagamento)
        });

        const dados = await resposta.json();

        if (!resposta.ok) {
            console.error('Erro do Mercado Pago ao criar Pix:', dados);
            return res.status(502).json({
                erro: 'Não foi possível gerar o Pix agora. Tente novamente em instantes ou use o pagamento manual.',
                detalhe: dados.message || 'erro_desconhecido'
            });
        }

        const pontoInteracao = dados.point_of_interaction && dados.point_of_interaction.transaction_data;
        if (!pontoInteracao || !pontoInteracao.qr_code) {
            console.error('Resposta do Mercado Pago sem QR Code:', dados);
            return res.status(502).json({ erro: 'Pix criado mas sem QR Code retornado. Tente novamente.' });
        }

        return res.status(200).json({
            payment_id: dados.id,
            qr_code: pontoInteracao.qr_code,
            qr_code_base64: pontoInteracao.qr_code_base64,
            status: dados.status
        });

    } catch (erro) {
        console.error('Erro inesperado ao criar Pix:', erro);
        return res.status(500).json({ erro: 'Erro interno ao gerar o Pix. Tente novamente ou use o pagamento manual.' });
    }
});

// ================================================================
// ROTA NOVA 2: Webhook do Mercado Pago
// Recebe o aviso de pagamento aprovado e credita o saldo automaticamente
// ================================================================
app.post('/webhook-pix', async (req, res) => {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
        console.error('MP_ACCESS_TOKEN não configurado');
        return res.status(500).send('erro de configuração');
    }

    try {
        const paymentId =
            (req.body && req.body.data && req.body.data.id) ||
            (req.query && req.query['data.id']) ||
            (req.query && req.query.id);

        const tipoNotificacao = (req.body && req.body.type) || req.query.type;

        if (!paymentId || tipoNotificacao !== 'payment') {
            return res.status(200).send('ignorado');
        }

        const respostaMP = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!respostaMP.ok) {
            console.error('Falha ao consultar pagamento no Mercado Pago:', await respostaMP.text());
            return res.status(200).send('erro ao consultar pagamento');
        }

        const pagamento = await respostaMP.json();

        if (pagamento.status !== 'approved') {
            return res.status(200).send('status: ' + pagamento.status);
        }

        const solicitacaoId = pagamento.external_reference;
        if (!solicitacaoId) {
            console.error('Pagamento aprovado sem external_reference:', pagamento.id);
            return res.status(200).send('sem referência da solicitação');
        }

        const db = obterDatabase();
        const refSolicitacao = db.ref('solicitacoesCredito/' + solicitacaoId);
        const snapSolicitacao = await refSolicitacao.once('value');
        const solicitacao = snapSolicitacao.val();

        if (!solicitacao) {
            console.error('Solicitação de crédito não encontrada:', solicitacaoId);
            return res.status(200).send('solicitação não encontrada');
        }

        if (solicitacao.status === 'aprovado') {
            return res.status(200).send('já processado anteriormente');
        }

        const telefoneNumeros = (solicitacao.telefone || '').replace(/\D/g, '');
        const valor = parseFloat(solicitacao.valor) || 0;

        const refCreditos = db.ref('creditos/' + telefoneNumeros);
        const snapCreditos = await refCreditos.once('value');
        const saldoAtual = parseFloat(snapCreditos.val()) || 0;
        const novoSaldo = saldoAtual + valor;

        await refCreditos.set(novoSaldo);
        await refSolicitacao.update({
            status: 'aprovado',
            pagoViaPixAutomatico: true,
            paymentId: pagamento.id
        });

        console.log(`Crédito de R$ ${valor} liberado automaticamente para telefone ${telefoneNumeros}`);
        return res.status(200).send('crédito liberado com sucesso');

    } catch (erro) {
        console.error('Erro inesperado no webhook do Pix:', erro);
        return res.status(200).send('erro interno registrado');
    }
});

// Rota simples pra você conferir no navegador se o servidor está de pé
app.get('/', (req, res) => {
    res.send('Servidor JD Show de Prêmios rodando! ✅');
});

// Configura o servidor para usar a porta da nuvem ou a 8080 se for local
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("🚀 SERVIDOR DO BINGO ONLINE RODANDO!");
});