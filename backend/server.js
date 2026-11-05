const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORTA = process.env.PORT || 3000;
const PASTA_FRONTEND = path.join(__dirname, "..", "frontend");

// Endpoint público da Steam. "cc=br" pede os preços em BRL e "l=brazilian" o texto em português.
const URL_STEAM = "https://store.steampowered.com/api/featuredcategories/?cc=br&l=brazilian";

// A API da Steam tem limite de requisições, então guardamos a resposta por 10 minutos.
const CACHE_STEAM_MS = 10 * 60 * 1000;
let cacheSteam = {
    dados: null,
    horario: 0
};

// A CheapShark é uma API pública que reúne ofertas de várias lojas.
// O storeID 25 é o da Epic Games Store.
const URL_EPIC = "https://www.cheapshark.com/api/1.0/deals?storeID=25&pageSize=24&onSale=1&lowerPrice=0.01&sortBy=Deal%20Rating";
const CACHE_EPIC_MS = 10 * 60 * 1000;
let cacheEpic = {
    dados: null,
    horario: 0
};

// API pública de câmbio. Usamos para converter os preços da Epic (USD) em reais.
const URL_CAMBIO = "https://economia.awesomeapi.com.br/json/last/USD-BRL";
const CACHE_CAMBIO_MS = 60 * 60 * 1000;
let cacheCambio = {
    taxa: null,
    horario: 0
};

const TIPOS_ARQUIVO = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2"
};

function responderJSON(res, status, dados) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(dados));
}

function responderTexto(res, status, texto) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(texto);
}

// Converte um item da Steam para o formato simples que o nosso frontend entende.
function converterJogo(item) {
    const precoOriginal = Number(item.original_price);
    const precoFinal = Number(item.final_price);

    return {
        id: item.id,
        nome: item.name,
        desconto: item.discount_percent,
        // A Steam envia os preços em centavos: 14990 -> R$ 149,90
        precoOriginal: precoOriginal / 100,
        precoFinal: precoFinal / 100,
        moeda: item.currency || "BRL",
        imagem: item.large_capsule_image || item.header_image || "",
        link: `https://store.steampowered.com/app/${item.id}/`,
        expiraEm: item.discount_expiration
            ? new Date(item.discount_expiration * 1000).toISOString()
            : null
    };
}

async function buscarPromocoesSteam() {
    const agora = Date.now();

    // Se a resposta anterior ainda é recente, devolvemos ela sem chamar a Steam de novo.
    if (cacheSteam.dados && agora - cacheSteam.horario < CACHE_STEAM_MS) {
        return { ...cacheSteam.dados, cache: true };
    }

    const resposta = await fetch(URL_STEAM, {
        headers: {
            "Accept": "application/json",
            "User-Agent": "PromoWeb/1.0"
        }
    });

    if (!resposta.ok) {
        throw new Error(`A Steam respondeu com o status ${resposta.status}.`);
    }

    const dadosSteam = await resposta.json();
    const itens = dadosSteam?.specials?.items ?? [];

    const jogos = itens
        .filter(function (item) {
            return item
                && item.discounted
                && Number.isFinite(Number(item.original_price))
                && Number.isFinite(Number(item.final_price))
                && Number(item.final_price) > 0;
        })
        .map(converterJogo)
        .sort(function (a, b) {
            return b.desconto - a.desconto;
        });

    cacheSteam = {
        dados: {
            loja: "Steam",
            moeda: "BRL",
            atualizadoEm: new Date().toISOString(),
            total: jogos.length,
            jogos: jogos
        },
        horario: agora
    };

    return { ...cacheSteam.dados, cache: false };
}

// Converte uma oferta da CheapShark para o mesmo formato usado pela Steam.
function converterJogoEpic(deal, taxaDolar) {
    const precoOriginalUSD = Number(deal.normalPrice);
    const precoFinalUSD = Number(deal.salePrice);

    // Multiplica o valor em dólar pela cotação e arredonda para 2 casas decimais.
    const precoOriginal = Number((precoOriginalUSD * taxaDolar).toFixed(2));
    const precoFinal = Number((precoFinalUSD * taxaDolar).toFixed(2));

    return {
        id: deal.gameID,
        nome: deal.title,
        desconto: Math.round(Number(deal.savings)),
        precoOriginal: precoOriginal,
        precoFinal: precoFinal,
        // Guardamos também o valor original em dólar para conferência.
        precoOriginalUSD: precoOriginalUSD,
        precoFinalUSD: precoFinalUSD,
        moeda: "BRL",
        precoAproximado: true,
        // Se o jogo existir na Steam, usamos uma imagem maior; senão, a imagem da CheapShark.
        imagem: deal.steamAppID
            ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${deal.steamAppID}/header.jpg`
            : deal.thumb,
        link: `https://www.cheapshark.com/redirect?dealID=${deal.dealID}`,
        expiraEm: null
    };
}

async function obterCotacaoDolar() {
    const agora = Date.now();

    // A cotação muda pouco durante o dia, então guardamos por 1 hora.
    if (cacheCambio.taxa && agora - cacheCambio.horario < CACHE_CAMBIO_MS) {
        return cacheCambio.taxa;
    }

    try {
        const resposta = await fetch(URL_CAMBIO, {
            headers: {
                "Accept": "application/json",
                "User-Agent": "PromoWeb/1.0 (projeto de estudo)"
            }
        });

        if (!resposta.ok) {
            throw new Error(`A API de câmbio respondeu com o status ${resposta.status}.`);
        }

        const dados = await resposta.json();
        const taxa = Number(dados?.USDBRL?.bid);

        if (!Number.isFinite(taxa) || taxa <= 0) {
            throw new Error("Cotação do dólar inválida.");
        }

        cacheCambio = { taxa: taxa, horario: agora };
        return taxa;
    } catch (erro) {
        // Se já temos uma cotação antiga, usamos ela em vez de derrubar a rota.
        if (cacheCambio.taxa) {
            console.error("Usando cotação antiga do dólar:", erro.message);
            return cacheCambio.taxa;
        }

        throw erro;
    }
}

async function buscarPromocoesEpic() {
    const agora = Date.now();

    if (cacheEpic.dados && agora - cacheEpic.horario < CACHE_EPIC_MS) {
        return { ...cacheEpic.dados, cache: true };
    }

    const resposta = await fetch(URL_EPIC, {
        headers: {
            "Accept": "application/json",
            // A CheapShark exige um User-Agent que identifique o cliente.
            "User-Agent": "PromoWeb/1.0 (projeto de estudo)"
        }
    });

    if (!resposta.ok) {
        throw new Error(`A CheapShark respondeu com o status ${resposta.status}.`);
    }

    const ofertas = await resposta.json();
    const taxaDolar = await obterCotacaoDolar();

    const jogos = ofertas
        .filter(function (deal) {
            return deal
                && deal.dealID
                && Number(deal.normalPrice) > 0
                && Number(deal.salePrice) < Number(deal.normalPrice);
        })
        // A nota da CheapShark ajuda a colocar os jogos mais relevantes primeiro.
        .sort(function (a, b) {
            return Number(b.dealRating) - Number(a.dealRating);
        })
        .map(function (deal) {
            return converterJogoEpic(deal, taxaDolar);
        });

    cacheEpic = {
        dados: {
            loja: "Epic Games",
            moeda: "BRL",
            precoAproximado: true,
            cotacaoDolar: taxaDolar,
            atualizadoEm: new Date().toISOString(),
            total: jogos.length,
            jogos: jogos
        },
        horario: agora
    };

    return { ...cacheEpic.dados, cache: false };
}

async function servirFrontend(res, caminho) {
    const arquivoRelativo = caminho === "/" ? "index.html" : caminho.replace(/^\/+/, "");
    const caminhoArquivo = path.resolve(PASTA_FRONTEND, arquivoRelativo);

    // Impede que alguém tente acessar arquivos fora da pasta frontend (path traversal).
    if (!caminhoArquivo.startsWith(PASTA_FRONTEND + path.sep)) {
        responderTexto(res, 403, "Acesso negado.");
        return;
    }

    try {
        const conteudo = await fs.readFile(caminhoArquivo);
        const extensao = path.extname(caminhoArquivo).toLowerCase();

        res.writeHead(200, {
            "Content-Type": TIPOS_ARQUIVO[extensao] || "application/octet-stream"
        });
        res.end(conteudo);
    } catch (erro) {
        if (erro.code === "ENOENT") {
            responderTexto(res, 404, "Página não encontrada.");
            return;
        }

        console.error("Erro ao ler arquivo:", erro);
        responderTexto(res, 500, "Erro interno do servidor.");
    }
}

const servidor = http.createServer(async function (req, res) {
    // CORS: permite que o frontend consiga chamar a API mesmo se estiver em outra porta/origem.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== "GET") {
        responderJSON(res, 405, { erro: "Método não permitido. Use GET." });
        return;
    }

    let caminho = "";

    try {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        caminho = decodeURIComponent(url.pathname);

        console.log(`${req.method} ${caminho}`);

        // Rota de teste: confirma que o backend está respondendo JSON.
        if (caminho === "/api/teste") {
            responderJSON(res, 200, {
                mensagem: "Minha primeira rota do PromoWeb!",
                funcionando: true,
                horario: new Date().toISOString()
            });
            return;
        }

        // Rota que busca as promoções na Steam e repassa para o frontend.
        if (caminho === "/api/steam") {
            const dados = await buscarPromocoesSteam();
            responderJSON(res, 200, dados);
            return;
        }

        // Rota que busca as promoções da Epic Games (via CheapShark).
        if (caminho === "/api/epic") {
            const dados = await buscarPromocoesEpic();
            responderJSON(res, 200, dados);
            return;
        }

        // Qualquer outra rota iniciada por /api responde JSON de "não encontrado".
        if (caminho.startsWith("/api/")) {
            responderJSON(res, 404, { erro: "Rota de API não encontrada." });
            return;
        }

        // Todo o resto é o site (HTML, CSS, JS).
        await servirFrontend(res, caminho);
    } catch (erro) {
        console.error("Erro na requisição:", erro);

        if (caminho === "/api/steam" || caminho === "/api/epic") {
            const loja = caminho === "/api/steam" ? "Steam" : "Epic Games";

            responderJSON(res, 502, {
                erro: `Não foi possível buscar as promoções da ${loja} agora. Tente novamente em instantes.`,
                detalhe: erro.message
            });
            return;
        }

        responderJSON(res, 500, { erro: "Erro interno do servidor." });
    }
});

servidor.listen(PORTA, function () {
    console.log(`PromoWeb rodando em http://localhost:${PORTA}`);
    console.log(`Rota de teste: http://localhost:${PORTA}/api/teste`);
    console.log(`Promoções da Steam: http://localhost:${PORTA}/api/steam`);
});
