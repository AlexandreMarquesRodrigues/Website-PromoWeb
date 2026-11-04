const formatadorReal = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
});

const formatadorDolar = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD"
});

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
        moeda: "USD",
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

    const precoOriginal = document.createElement("span");
    precoOriginal.className = "preco-original";
    precoOriginal.textContent = formatador.format(jogo.precoOriginal);

    const precoFinal = document.createElement("span");
    precoFinal.className = "preco-final";
    precoFinal.textContent = jogo.precoFinal === 0 ? "Grátis" : formatador.format(jogo.precoFinal);

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
        const resposta = await fetch(`/api/${loja.rota}`);

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

        const notaMoeda = dados.moeda === "USD" ? " • Preços em US$" : "";
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