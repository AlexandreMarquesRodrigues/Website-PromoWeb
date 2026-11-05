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

// A Nuuvem não tem uma API pública documentada para o catálogo.
// Por isso lemos a página de promoções, que já vem com os produtos em HTML.
const URL_NUUVEM = "https://www.nuuvem.com/br-pt/catalog/platforms/pc/price/promo/sort/bestselling/sort-mode/desc";
const CACHE_NUUVEM_MS = 10 * 60 * 1000;
let cacheNuuvem = {
    dados: null,
    horario: 0
};

// A Eneba usa o Algolia na busca do próprio site. Esta é a chave pública
// que o frontend da Eneba utiliza; ela só permite consultar os índices.
const APP_ID_ENEBA = "IHJZQ5LW2R";
const CHAVE_ENEBA = "53864095e814940ffed0f69a897331f1";
const URL_ENEBA = `https://${APP_ID_ENEBA}-dsn.algolia.net/1/indexes/products_br/query`;
const CACHE_ENEBA_MS = 10 * 60 * 1000;
let cacheEneba = {
    dados: null,
    horario: 0
};

// A Instant Gaming monta a página "Ofertas do dia" no servidor, já com os
// preços finais em BRL. Para recuperar o preço original em BRL, usamos o
// índice público do Algolia que o próprio site consulta.
const URL_INSTANT_GAMING = "https://www.instant-gaming.com/br/ofertas-do-dia/";
const URL_REFERER_INSTANT_GAMING = "https://www.instant-gaming.com/br/";
const APP_ID_INSTANT_GAMING = "QKNHP8TC3Y";
const CHAVE_INSTANT_GAMING = "93946b91c013211f842ddf1819ea880b";
const URL_ALGOLIA_INSTANT_GAMING = `https://${APP_ID_INSTANT_GAMING}-dsn.algolia.net/1/indexes/*/objects`;
const CACHE_INSTANT_GAMING_MS = 10 * 60 * 1000;
let cacheInstantGaming = {
    dados: null,
    horario: 0
};

// APIs públicas de câmbio. Tentamos na ordem; se uma falhar, usamos a próxima.
// A AwesomeAPI às vezes responde 429 (limite de requisições) em servidores na nuvem.
const FONTES_CAMBIO = [
    {
        nome: "AwesomeAPI",
        url: "https://economia.awesomeapi.com.br/json/last/USD-BRL",
        extrair: function (dados) {
            return Number(dados?.USDBRL?.bid);
        }
    },
    {
        nome: "Frankfurter",
        url: "https://api.frankfurter.app/latest?from=USD&to=BRL",
        extrair: function (dados) {
            return Number(dados?.rates?.BRL);
        }
    },
    {
        nome: "Open ER API",
        url: "https://open.er-api.com/v6/latest/USD",
        extrair: function (dados) {
            return Number(dados?.rates?.BRL);
        }
    }
];
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
        // O capsule 616x353 tem a mesma proporção dos cards (616/353).
        // Se ele não existir, o frontend troca pelo header.jpg.
        imagem: deal.steamAppID
            ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${deal.steamAppID}/capsule_616x353.jpg`
            : deal.thumb,
        imagemAlternativa: deal.steamAppID
            ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${deal.steamAppID}/header.jpg`
            : null,
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

    let ultimoErro = null;

    // Tenta cada fonte de câmbio em ordem. Se uma falhar, passa para a próxima.
    for (const fonte of FONTES_CAMBIO) {
        try {
            const resposta = await fetch(fonte.url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "PromoWeb/1.0 (projeto de estudo)"
                },
                signal: AbortSignal.timeout(8000)
            });

            if (!resposta.ok) {
                throw new Error(`${fonte.nome} respondeu com o status ${resposta.status}.`);
            }

            const dados = await resposta.json();
            const taxa = fonte.extrair(dados);

            if (!Number.isFinite(taxa) || taxa <= 0) {
                throw new Error(`${fonte.nome} devolveu uma cotação inválida.`);
            }

            cacheCambio = { taxa: taxa, horario: agora };
            console.log(`Cotação do dólar obtida em ${fonte.nome}: R$ ${taxa}`);
            return taxa;
        } catch (erro) {
            ultimoErro = erro;
            console.error(`Falha ao buscar cotação em ${fonte.nome}:`, erro.message);
        }
    }

    // Se nenhuma fonte funcionar, usa a última cotação conhecida.
    if (cacheCambio.taxa) {
        console.error("Usando cotação antiga do dólar:", ultimoErro.message);
        return cacheCambio.taxa;
    }

    // Último recurso para a seção Epic não ficar vazia.
    const taxaEmergencia = 5.50;
    console.error("Usando cotação de emergência:", ultimoErro.message);
    return taxaEmergencia;
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

// A página da Nuuvem vem com os dados do produto dentro de atributos HTML.
// Esta função desfaz as entidades para conseguirmos ler o JSON.
function decodificarEntidadesHTML(texto) {
    return String(texto)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

function lerPrecoNuuvem(atributo) {
    if (!atributo) {
        return null;
    }

    try {
        const dados = JSON.parse(decodificarEntidadesHTML(atributo));
        const valor = Number(dados.v);

        // A Nuuvem guarda o preço em centavos: 21999 -> R$ 219,99
        return Number.isFinite(valor) ? valor / 100 : null;
    } catch (erro) {
        return null;
    }
}

function converterJogoNuuvem(card) {
    const atributoDados = card.match(/data-wishlist-button-product-data-value="([^"]*)"/);
    let dados = null;

    if (atributoDados) {
        try {
            dados = JSON.parse(decodificarEntidadesHTML(atributoDados[1]));
        } catch (erro) {
            dados = null;
        }
    }

    const precoOriginal = lerPrecoNuuvem(card.match(/data-base-price="([^"]*)"/)?.[1]);
    const precoFinal = lerPrecoNuuvem(card.match(/data-price="([^"]*)"/)?.[1]);

    if (!dados || !dados.name || !dados.url || !precoOriginal || !precoFinal || precoFinal >= precoOriginal) {
        return null;
    }

    const imagem = card.match(/<img[^>]+class="[^"]*game-cover__item[^"]*"[^>]*src="([^"]+)"/);
    const banner = card.match(/data-banner="([^"]+)"/)?.[1];
    const id = card.match(/data-product-id="([^"]+)"/)?.[1] || dados.id;

    return {
        id: id,
        nome: dados.name,
        desconto: Math.round((1 - precoFinal / precoOriginal) * 100),
        precoOriginal: precoOriginal,
        precoFinal: precoFinal,
        moeda: "BRL",
        imagem: imagem
            ? (imagem[1].startsWith("//") ? `https:${imagem[1]}` : imagem[1])
            : banner
                ? `https://assets.nuuvem.com/image/upload/t_banner_big/v1/${banner}`
                : dados.image_url,
        link: dados.url,
        expiraEm: null
    };
}

function extrairJogosNuuvem(html) {
    const cards = html.match(/<article[^>]*data-component="product-card"[^>]*>[\s\S]*?<\/article>/g) || [];

    return cards
        .map(converterJogoNuuvem)
        .filter(function (jogo) {
            return jogo !== null;
        });
}

async function buscarPromocoesNuuvem() {
    const agora = Date.now();

    if (cacheNuuvem.dados && agora - cacheNuuvem.horario < CACHE_NUUVEM_MS) {
        return { ...cacheNuuvem.dados, cache: true };
    }

    const resposta = await fetch(URL_NUUVEM, {
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
            // A Nuuvem pode bloquear requisições sem um navegador identificado.
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        }
    });

    if (!resposta.ok) {
        throw new Error(`A Nuuvem respondeu com o status ${resposta.status}.`);
    }

    const html = await resposta.text();
    const jogos = extrairJogosNuuvem(html);

    if (jogos.length === 0) {
        throw new Error("Nenhuma promoção da Nuuvem foi encontrada na página.");
    }

    cacheNuuvem = {
        dados: {
            loja: "Nuuvem",
            moeda: "BRL",
            atualizadoEm: new Date().toISOString(),
            total: jogos.length,
            jogos: jogos
        },
        horario: agora
    };

    return { ...cacheNuuvem.dados, cache: false };
}

// A Eneba é um marketplace de chaves. A busca pública devolve os produtos
// em centavos de BRL e com a imagem em formato retrato.
function converterJogoEneba(hit) {
    const nome = hit.translations?.pt_BR?.name || hit.translations?.en_US?.name;
    const precoOriginal = Number(hit.msrp?.BRL) / 100;
    const precoFinal = Number(hit.lowestPrice?.BRL) / 100;
    const drm = String(hit.drmName || "").toLowerCase();
    const regioes = Array.isArray(hit.productRegions) ? hit.productRegions : [];
    const regiaoValida = regioes.some(function (regiao) {
        return ["global", "latam", "brazil", "row"].includes(regiao);
    });

    if (!nome || !hit.slug) {
        return null;
    }

    if (!Number.isFinite(precoOriginal) || !Number.isFinite(precoFinal)) {
        return null;
    }

    if (precoOriginal <= 0 || precoFinal <= 0 || precoFinal >= precoOriginal) {
        return null;
    }

    // Evita chaves aleatórias e produtos de regiões que não ativam no Brasil.
    if (drm.includes("random") || !regiaoValida) {
        return null;
    }

    const imagem = hit.images?.cover300?.src2x || hit.images?.cover300?.src;

    if (!imagem) {
        return null;
    }

    return {
        id: hit.objectID,
        nome: nome,
        desconto: Math.round((1 - precoFinal / precoOriginal) * 100),
        precoOriginal: precoOriginal,
        precoFinal: precoFinal,
        moeda: "BRL",
        imagem: imagem,
        link: `https://www.eneba.com/br/${hit.slug}`,
        expiraEm: null
    };
}

async function buscarPromocoesEneba() {
    const agora = Date.now();

    if (cacheEneba.dados && agora - cacheEneba.horario < CACHE_ENEBA_MS) {
        return { ...cacheEneba.dados, cache: true };
    }

    const resposta = await fetch(URL_ENEBA, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Algolia-Application-Id": APP_ID_ENEBA,
            "X-Algolia-API-Key": CHAVE_ENEBA
        },
        body: JSON.stringify({
            query: "",
            hitsPerPage: 200,
            // Somente jogos com estoque e que não estão bloqueados no Brasil.
            filters: '(stockAvailable:true) AND (NOT regionBlacklist:"brazil") AND (productType:"game")',
            attributesToRetrieve: [
                "slug",
                "objectID",
                "translations",
                "images",
                "lowestPrice",
                "msrp",
                "productRegions",
                "drmName"
            ]
        })
    });

    if (!resposta.ok) {
        throw new Error(`A Eneba respondeu com o status ${resposta.status}.`);
    }

    const dados = await resposta.json();
    const jogos = (dados.hits || [])
        .map(converterJogoEneba)
        .filter(function (jogo) {
            return jogo !== null;
        })
        .slice(0, 24);

    if (jogos.length === 0) {
        throw new Error("Nenhuma promoção da Eneba foi encontrada.");
    }

    cacheEneba = {
        dados: {
            loja: "Eneba",
            moeda: "BRL",
            atualizadoEm: new Date().toISOString(),
            total: jogos.length,
            jogos: jogos
        },
        horario: agora
    };

    return { ...cacheEneba.dados, cache: false };
}

function converterPrecoBRL(texto) {
    if (!texto) {
        return null;
    }

    const limpo = String(texto)
        .replace(/&nbsp;/g, " ")
        .replace(/R\$\s*/i, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .trim();

    const valor = Number(limpo);
    return Number.isFinite(valor) ? valor : null;
}

// A página de ofertas do dia só mostra o preço final e o desconto.
// O desconto é calculado sobre o preço de tabela em EUR. O Algolia guarda
// esse valor de tabela; multiplicamos pela taxa EUR -> BRL que vem na página.
function extrairJogosInstantGaming(html) {
    const blocos = html.match(/<article[\s\S]*?<\/article>/g) || [];
    const jogos = [];

    for (const bloco of blocos) {
        const link = bloco.match(/href="(https:\/\/www\.instant-gaming\.com\/br\/(\d+)-[^"]+)"/);
        const nome = bloco.match(/<span class="title" title="([^"]+)"/);
        const imagem = bloco.match(/data-src="([^"]+)"/);
        const desconto = bloco.match(/class="discount">\s*-(\d+)%/);
        const preco = bloco.match(/R\$(?:&nbsp;|\s)*([0-9.,]+)/);

        if (!link || !nome || !imagem || !desconto || !preco) {
            continue;
        }

        const precoFinal = converterPrecoBRL(preco[1]);
        const percentual = Number(desconto[1]);

        if (!Number.isFinite(precoFinal) || precoFinal <= 0) {
            continue;
        }

        if (!Number.isFinite(percentual) || percentual <= 0 || percentual >= 100) {
            continue;
        }

        jogos.push({
            id: link[2],
            nome: decodificarEntidadesHTML(nome[1]),
            desconto: percentual,
            precoFinal: precoFinal,
            moeda: "BRL",
            imagem: decodificarEntidadesHTML(imagem[1]),
            link: link[1].split("?")[0],
            expiraEm: null,
            // Caso o Algolia não responda, usamos este valor aproximado.
            _precoOriginalCalculado: Number((precoFinal / (1 - percentual / 100)).toFixed(2))
        });
    }

    return jogos;
}

async function completarPrecosOriginaisInstantGaming(jogos, taxaEur) {
    const usarAlgolia = Number.isFinite(taxaEur) && taxaEur > 0;

    if (!usarAlgolia || jogos.length === 0) {
        jogos.forEach(function (jogo) {
            jogo.precoOriginal = jogo._precoOriginalCalculado;
            delete jogo._precoOriginalCalculado;
        });
        return jogos;
    }

    try {
        const resposta = await fetch(URL_ALGOLIA_INSTANT_GAMING, {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "X-Algolia-Application-Id": APP_ID_INSTANT_GAMING,
                "X-Algolia-API-Key": CHAVE_INSTANT_GAMING,
                // O Algolia da Instant Gaming confere o referer.
                "Referer": URL_REFERER_INSTANT_GAMING,
                "Origin": "https://www.instant-gaming.com"
            },
            body: JSON.stringify({
                requests: jogos.map(function (jogo) {
                    return {
                        indexName: "produits_br",
                        objectID: jogo.id
                    };
                })
            }),
            signal: AbortSignal.timeout(8000)
        });

        if (!resposta.ok) {
            throw new Error(`O Algolia respondeu com o status ${resposta.status}.`);
        }

        const dados = await resposta.json();
        const porId = new Map();

        (dados.results || []).forEach(function (hit) {
            if (hit && hit.prod_id) {
                porId.set(String(hit.prod_id), hit);
            }
        });

        jogos.forEach(function (jogo) {
            const hit = porId.get(jogo.id);
            const retail = Number(hit?.retail);
            const moedaRetail = hit?.retail_currency;
            let precoOriginal = null;
            console.log(`Promoções da Instant Gaming: http://localhost:${PORTA}/api/instant-gaming`);
            if (moedaRetail === "BRL" && Number.isFinite(retail)) {
                precoOriginal = retail;
            } else if (Number.isFinite(retail) && (!moedaRetail || moedaRetail === "EUR")) {
                precoOriginal = Number((retail * taxaEur).toFixed(2));
            }

            if (precoOriginal && precoOriginal > jogo.precoFinal) {
                jogo.precoOriginal = Number(precoOriginal.toFixed(2));
            } else {
                jogo.precoOriginal = jogo._precoOriginalCalculado;
            }
        });
    } catch (erro) {
        console.error("Falha ao buscar os preços originais da Instant Gaming:", erro.message);

        jogos.forEach(function (jogo) {
            jogo.precoOriginal = jogo._precoOriginalCalculado;
        });
    }

    jogos.forEach(function (jogo) {
        delete jogo._precoOriginalCalculado;
    });

    return jogos;
}

async function buscarPromocoesInstantGaming() {
    const agora = Date.now();

    if (cacheInstantGaming.dados && agora - cacheInstantGaming.horario < CACHE_INSTANT_GAMING_MS) {
        return { ...cacheInstantGaming.dados, cache: true };
    }

    const resposta = await fetch(URL_INSTANT_GAMING, {
        headers: {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        }
    });

    if (!resposta.ok) {
        throw new Error(`A Instant Gaming respondeu com o status ${resposta.status}.`);
    }

    const html = await resposta.text();
    const taxaEur = Number(html.match(/window\.user\s*=\s*\{[\s\S]*?currency:\s*\{[\s\S]*?rate:\s*"([\d.]+)"/)?.[1]);
    const jogos = extrairJogosInstantGaming(html);

    if (jogos.length === 0) {
        throw new Error("Nenhuma promoção da Instant Gaming foi encontrada na página.");
    }

    await completarPrecosOriginaisInstantGaming(jogos, taxaEur);

    const selecionados = jogos.slice(0, 24);

    cacheInstantGaming = {
        dados: {
            loja: "Instant Gaming",
            moeda: "BRL",
            atualizadoEm: new Date().toISOString(),
            total: selecionados.length,
            jogos: selecionados
        },
        horario: agora
    };

    return { ...cacheInstantGaming.dados, cache: false };
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

        // Rota que busca as promoções da Nuuvem.
        if (caminho === "/api/nuuvem") {
            const dados = await buscarPromocoesNuuvem();
            responderJSON(res, 200, dados);
            return;
        }

        // Rota que busca as promoções da Eneba.
        if (caminho === "/api/eneba") {
            const dados = await buscarPromocoesEneba();
            responderJSON(res, 200, dados);
            return;
        }

        // Rota que busca as promoções da Instant Gaming.
        if (caminho === "/api/instant-gaming") {
            const dados = await buscarPromocoesInstantGaming();
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

        if (caminho === "/api/steam" || caminho === "/api/epic" || caminho === "/api/nuuvem" || caminho === "/api/eneba" || caminho === "/api/instant-gaming") {
            const loja = caminho === "/api/steam"
                ? "Steam"
                : caminho === "/api/epic"
                    ? "Epic Games"
                    : caminho === "/api/nuuvem"
                        ? "Nuuvem"
                        : caminho === "/api/eneba"
                            ? "Eneba"
                            : "Instant Gaming";

            responderJSON(res, 502, {
                erro: `Não foi possível buscar as promoções da ${loja}.`,
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
    console.log(`Promoções da Nuuvem: http://localhost:${PORTA}/api/nuuvem`);
    console.log(`Promoções da Eneba: http://localhost:${PORTA}/api/eneba`);
});
