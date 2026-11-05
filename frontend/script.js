const formatadorReal = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
});

const formatadorDolar = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD"
});

// No computador usamos o backend local. No Vercel, usamos o backend do Render.
const API_URL = location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? ""
    : "https://website-promoweb.onrender.com";

const lojas = [
    {
        nome: "Steam",
        rota: "steam",
        moeda: "BRL",
        lista: document.getElementById("steam-promocoes"),
        status: document.getElementById("status-steam")
    },
    {
        nome: "Epic Games",
        rota: "epic",
        moeda: "BRL",
        lista: document.getElementById("eg-promocoes"),
        status: document.getElementById("status-epic")
    }
];

function criarCard(jogo) {
    const formatador = jogo.moeda === "USD" ? formatadorDolar : formatadorReal;

    const card = document.createElement("a");
    card.className = "card";
    card.href = jogo.link;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.title = `Ver oferta de ${jogo.nome}`;

    const capa = document.createElement("div");
    capa.className = "card-capa";

    const imagem = document.createElement("img");
    imagem.src = jogo.imagem;
    imagem.alt = `Capa de ${jogo.nome}`;
    imagem.loading = "lazy";
    capa.appendChild(imagem);

    const selo = document.createElement("span");
    selo.className = "selo-desconto";
    selo.textContent = `-${jogo.desconto}%`;
    capa.appendChild(selo);

    const info = document.createElement("div");
    info.className = "card-info";

    const titulo = document.createElement("h3");
    titulo.textContent = jogo.nome;

    const precos = document.createElement("div");
    precos.className = "precos";

    // O "≈" avisa que o valor foi convertido de dólar para real.
    const prefixo = jogo.precoAproximado ? "≈ " : "";

    const precoOriginal = document.createElement("span");
    precoOriginal.className = "preco-original";
    precoOriginal.textContent = prefixo + formatador.format(jogo.precoOriginal);

    const precoFinal = document.createElement("span");
    precoFinal.className = "preco-final";
    precoFinal.textContent = jogo.precoFinal === 0
        ? "Grátis"
        : prefixo + formatador.format(jogo.precoFinal);

    // Ao passar o mouse, mostra o valor original em dólar.
    if (jogo.precoOriginalUSD !== undefined && jogo.precoFinalUSD !== undefined) {
        precoOriginal.title = formatadorDolar.format(jogo.precoOriginalUSD);
        precoFinal.title = formatadorDolar.format(jogo.precoFinalUSD);
    }

    precos.append(precoOriginal, precoFinal);
    info.append(titulo, precos);
    card.append(capa, info);

    return card;
}

async function carregarPromocoes(loja) {
    const avisoMoeda = loja.moeda === "USD" ? " (preços em US$)" : "";
    loja.status.textContent = `Carregando promoções da ${loja.nome}${avisoMoeda}...`;
    loja.status.className = "status";
    loja.lista.replaceChildren();

    try {
        const resposta = await fetch(`${API_URL}/api/${loja.rota}`);

        // Se o backend devolver um erro em JSON, aproveitamos a mensagem dele.
        const dados = await resposta.json().catch(function () {
            return null;
        });

        if (!resposta.ok) {
            throw new Error(dados && dados.erro ? dados.erro : `Erro HTTP ${resposta.status}`);
        }

        if (!dados || !Array.isArray(dados.jogos) || dados.jogos.length === 0) {
            loja.status.textContent = `Nenhuma promoção da ${loja.nome} no momento.`;
            return;
        }

        const fragmento = document.createDocumentFragment();
        dados.jogos.forEach(function (jogo) {
            fragmento.appendChild(criarCard(jogo));
        });
        loja.lista.appendChild(fragmento);

        const hora = new Date(dados.atualizadoEm).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit"
        });

        const notaMoeda = dados.precoAproximado ? " • Valores aproximados em R$" : "";
        loja.status.textContent = `${dados.total} promoções${notaMoeda} • Atualizadas às ${hora}`;
    } catch (erro) {
        console.error(`Erro ao carregar promoções da ${loja.nome}:`, erro);

        loja.status.textContent = `Não foi possível carregar as promoções da ${loja.nome}.`;
        loja.status.className = "status erro";

        const botao = document.createElement("button");
        botao.type = "button";
        botao.className = "botao-tentar";
        botao.textContent = "Tentar novamente";
        botao.addEventListener("click", function () {
            carregarPromocoes(loja);
        });

        loja.status.append(botao);
    }
}

lojas.forEach(function (loja) {
    carregarPromocoes(loja);
});