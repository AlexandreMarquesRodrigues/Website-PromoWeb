# PromoWeb

Agregador de promoções de jogos digitais. O backend consulta a API pública da Steam, converte os preços para BRL e entrega os dados em JSON para o frontend exibir os cards.

## Como rodar

Requisitos: Node.js 18 ou superior (o projeto usa o `fetch` nativo do Node).

```bash
cd backend
npm start
```

Depois abra no navegador:

- Site: http://localhost:3000
- Rota de teste: http://localhost:3000/api/teste
- Promoções da Steam: http://localhost:3000/api/steam

Para desenvolver com reinício automático ao salvar arquivos:

```bash
npm run dev
```

## Estrutura

```
PromoWeb/
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
└── backend/
    ├── server.js
    └── package.json
```

## Como funciona

1. O navegador acessa `http://localhost:3000`.
2. O `server.js` serve os arquivos da pasta `frontend`.
3. O `script.js` chama `/api/steam`.
4. O backend consulta `store.steampowered.com`, converte os preços de centavos para reais e devolve JSON.
5. O frontend monta os cards com capa, desconto, preço original, preço promocional e link para a loja.

O backend guarda a resposta da Steam em cache por 10 minutos para não estourar o limite de requisições da API.

## Rotas

| Rota | Descrição |
| --- | --- |
| `GET /api/teste` | Confirma que o backend está respondendo JSON |
| `GET /api/steam` | Lista as promoções da Steam em BRL |

## Próximos passos

- Integrar a Epic Games.
- Estudar APIs de afiliados das demais lojas (Nuuvem, Eneba, Instant Gaming, G2A e Thunder Keys) — elas não possuem uma API pública simples como a da Steam.
- Criar o banco no Supabase (PostgreSQL) e a autenticação com Supabase Auth.
- Implementar wishlist, favoritos e alertas de promoção.
- Adicionar painel de administração para usuários autorizados.
