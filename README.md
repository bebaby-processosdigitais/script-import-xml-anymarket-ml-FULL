# Robô de Importação Full — Anymarket → Sankhya TGFIXN

Importa automaticamente os XMLs de documentos fiscais do Mercado Livre Full (via API da
Anymarket) para dentro do Sankhya, gravando na tabela `TGFIXN` para que o motor de
importação do ERP processe e gere as notas.

**Arquivo:** `robo_full_tgfixn_lote.js`
**Versão:** lote / agendável — 27/08/2026
**Substitui:** `robo_devolucao_full_tgfixn.js` (versão de uma nota por clique)

---

## Índice

1. [O que ele faz](#1-o-que-ele-faz)
2. [Como funciona](#2-como-funciona)
3. [Instalação](#3-instalação)
4. [Configuração](#4-configuração)
5. [Como testar antes de agendar](#5-como-testar-antes-de-agendar)
6. [Agendamento](#6-agendamento)
7. [Operação e monitoramento](#7-operação-e-monitoramento)
8. [Habilitando novos tipos de documento](#8-habilitando-novos-tipos-de-documento)
9. [Solução de problemas](#9-solução-de-problemas)
10. [Limitações conhecidas](#10-limitações-conhecidas)
11. [Decisões de projeto](#11-decisões-de-projeto)

---

## 1. O que ele faz

```
Anymarket API → filtra tipos habilitados → descarta o que já existe
              → baixa só os XMLs novos → grava na TGFIXN (STATUS 0)
              → motor do Sankhya processa e gera a nota
```

O robô **não** monta a nota fiscal, **não** define a TOP (tipo de operação) e **não**
cadastra parceiro. Isso é trabalho do motor de importação do Sankhya, que aplica as
"regras do Full" configuradas pelo Paulo Vieira.

### O que ele resolve

A integração terceirizada (Tem Api) parou de trazer as notas do Full em **29/06/2026**.
Desde então, notas de venda e devolução do Full não caem mais no Sankhya
automaticamente. Este robô substitui essa função.

---

## 2. Como funciona

O script roda em quatro etapas separadas de propósito.

### Etapa 1 — Carrega o que já existe

Uma única query traz todos os `NOMEARQUIVO` já presentes na `TGFIXN` para um objeto em
memória:

```sql
SELECT NOMEARQUIVO FROM TGFIXN WHERE NOMEARQUIVO LIKE 'INVOICE-%'
```

Depois disso o teste de duplicidade é instantâneo, sem ida ao banco por documento.

### Etapa 2 — Varre a listagem (sem baixar nada)

Pagina a API da Anymarket montando uma fila de documentos novos. Nenhum download de XML
acontece aqui — é o que permite varrer ~1000 documentos de forma barata.

Para quando a fila atinge `LIMITE_LOTE` ou quando acaba a paginação.

### Etapa 3 — Baixa e grava

Percorre a fila, uma nota por vez, cada uma isolada em `try/catch`. Um XML corrompido
incrementa o contador de falhas e o lote continua.

Antes de gravar, há uma segunda checagem de duplicidade — agora por `CHAVEACESSO`.

### Etapa 4 — Log

Grava um registro de resumo na `AD_TESTENOTA`, porque em ação agendada não existe tela
para exibir `mensagem`.

### Identidade dos documentos (o dedup)

O identificador universal é o **nome do arquivo na URL do S3**:

```
https://s3.../transactionType-devolution/259061706.6606158899.xml
                                          └──────────┬─────────┘
                                            identificador
```

`NOMEARQUIVO` final: `INVOICE-devolution-259061706.6606158899.XML`

**Por que esse e não outro:** os campos que a API retorna por documento são apenas `id`,
`url`, `marketplace`, `type` e `subType` — e nem todos existem em todos os tipos. O `id`
está **ausente** nos documentos `sale`; o `idOrder` (usado na versão anterior) está
**ausente** nos `symbolic_inbound_return`. Sonda de 27/08/2026 varreu a conta inteira e
confirmou: o identificador da URL é único em **100% dos documentos**, sem repetições e
sem vazios.

O `type` foi incluído no nome porque a coluna é `VARCHAR2(200)` e o espaço é gratuito —
permite contar documentos por tipo na `TGFIXN` sem abrir XML nenhum.

---

## 3. Instalação

### Pré-requisitos

- Acesso ao Sankhya com permissão para editar ações de tela.
- Token da API da Anymarket (`gumgaToken`) válido.
- Tela `AD_TESTENOTA` publicada (usada como gatilho de teste e como destino do log).

### Passos

1. **Criar o parâmetro do sistema** com o token:
   - Nome: `ANYMARKET_TOKEN`
   - Valor: o token da Anymarket
   - ⚠️ Nunca versionar, colar em chat ou deixar em log.

2. **Colar o script** na ação Script "Verificar Parceiro" da tela `AD_TESTENOTA`
   (o botão ⚡).

3. **Testar pelo botão** antes de agendar — ver [seção 5](#5-como-testar-antes-de-agendar).

4. **Criar a ação agendada** — ver [seção 6](#6-agendamento).

---

## 4. Configuração

Todas as variáveis ficam no topo do arquivo.

| Variável | Padrão | O que faz |
|---|---|---|
| `PARAM_TOKEN` | `"ANYMARKET_TOKEN"` | Nome do parâmetro do sistema que guarda o token |
| `TOKEN_FALLBACK` | `""` | Token direto no código. **Só para teste — deixar vazio em produção** |
| `CODEMP_FIXO` | `1` | Empresa. Todas as 121 notas do histórico usam 1 |
| `CODUSU_IMP` | `0` | Usuário de importação. Irrelevante — qualquer valor processa |
| `LIMITE_LOTE` | `40` | Notas gravadas por rodada. Evita timeout |
| `MAX_PAGINAS` | `30` | Páginas de listagem varridas por rodada |
| `PAGE_SIZE` | `50` | Itens por página. **Mínimo aceito pela API é 5** |
| `TIPOS` | 2 ativos | Tipos de documento habilitados |

### Dimensionando o lote

`LIMITE_LOTE = 40` rodando de hora em hora dá capacidade de ~960 notas/dia — folgado
para o volume atual (~1000 documentos históricos, e poucas notas novas por dia).

Se o agendamento estourar timeout, reduza para 20 e aumente a frequência.

---

## 5. Como testar antes de agendar

**Não suba direto para agendamento.** A sequência segura:

### Passo 1 — Rodada mínima

Ajuste temporariamente:

```javascript
var LIMITE_LOTE = 3;
```

Rode pelo botão da `AD_TESTENOTA`. A caixa de mensagem deve mostrar algo como:

```
Conhecidos: 14 | Vistos: 850 | Outros tipos: 833 | Já tinha: 4 |
Fila: 3 | GRAVADAS: 3 | FALHAS: 0
```

### Passo 2 — Interpretando o resumo

| Campo | Significado | O que esperar |
|---|---|---|
| `Conhecidos` | Linhas `INVOICE-%` já na TGFIXN | Cresce a cada rodada |
| `Vistos` | Documentos percorridos na listagem | Alto (a maioria é de outro tipo) |
| `Outros tipos` | Descartados pelo filtro `TIPOS` | Alto enquanto só 2 tipos estiverem ativos |
| `Já tinha` | Descartados pelo dedup | Cresce até igualar o total do tipo |
| `Fila` | Selecionados para gravar | ≤ `LIMITE_LOTE` |
| `GRAVADAS` | Sucesso | O que importa |
| `FALHAS` | Erros isolados | Idealmente 0 |

### Passo 3 — Conferir no banco

```sql
SELECT * FROM (
  SELECT NUARQUIVO, NOMEARQUIVO, CHAVEACESSO, STATUS, TIPONFE, ENTSAINFE,
         NUMNOTA, SERIEDOC, VLRNOTA, XNOMEDEST, CNPJPARC, DHIMPORT
  FROM TGFIXN
  WHERE NOMEARQUIVO LIKE 'INVOICE-%'
  ORDER BY NUARQUIVO DESC
) WHERE ROWNUM <= 10;
```

Checar: `TIPONFE` = `E` nas devoluções, `ENTSAINFE` = `0`, `NUMNOTA` e `SERIEDOC`
preenchidos, `CNPJPARC` com o documento do consumidor (não o da BeBaby), `CODTIPOPER`
**vazio** (o motor preenche).

### Passo 4 — Rodar de novo

Segunda execução com os mesmos parâmetros deve dar `GRAVADAS: 0` e o `Já tinha` maior.
**Se gravar duplicado, pare e investigue o dedup antes de seguir.**

### Passo 5 — Só então

Restaurar `LIMITE_LOTE = 40` e criar o agendamento.

---

## 6. Agendamento

O script foi escrito para funcionar sem sessão de usuário. Quatro adaptações já estão
embutidas:

| Diferença em ação agendada | Como o script lida |
|---|---|
| Não existe `linhas[0]` nem linha selecionada | Não usa nenhum dos dois |
| `mensagem =` pode não aparecer em lugar nenhum | Grava log na `AD_TESTENOTA` |
| `throw` derruba o agendamento com rollback | `try/catch` por nota; `throw` só em erro fatal de configuração |
| Sem usuário logado | Token vem de `getParametroSistema` |

### Frequência sugerida

De hora em hora, ou a cada 30 minutos. As notas do Full não são urgentes ao minuto, e
frequência menor reduz o custo de varredura.

### Antes de ligar

- [ ] Parâmetro `ANYMARKET_TOKEN` criado e válido
- [ ] `TOKEN_FALLBACK` vazio
- [ ] Testado pelo botão com sucesso (seção 5)
- [ ] Segunda execução não duplicou
- [ ] `LIMITE_LOTE` restaurado

---

## 7. Operação e monitoramento

### Ver as últimas rodadas

```sql
SELECT * FROM (
  SELECT CODNOTA, TIPONOTA, STATUS, NOMEPARC, DTIMPORT
  FROM AD_TESTENOTA
  WHERE TIPONOTA = 'ROBO LOTE'
  ORDER BY CODNOTA DESC
) WHERE ROWNUM <= 20;
```

`STATUS` guarda o resumo; `NOMEPARC` guarda os erros (ou `"sem erros"`).

### Ver o que está travado sem processar

```sql
SELECT NUARQUIVO, NOMEARQUIVO, STATUS, DHIMPORT, DHPROCESS, DETALHESIMPORTACAO
FROM TGFIXN
WHERE NOMEARQUIVO LIKE 'INVOICE-%' AND STATUS = 0
ORDER BY DHIMPORT DESC;
```

`DETALHESIMPORTACAO` é a fonte de verdade quando o motor recusa uma nota.

### Contar por tipo (graças ao `type` no nome do arquivo)

```sql
SELECT SUBSTR(NOMEARQUIVO, 9, INSTR(NOMEARQUIVO, '-', 9) - 9) AS TIPO,
       STATUS, COUNT(*) AS QTD
FROM TGFIXN
WHERE NOMEARQUIVO LIKE 'INVOICE-%-%'
GROUP BY SUBSTR(NOMEARQUIVO, 9, INSTR(NOMEARQUIVO, '-', 9) - 9), STATUS
ORDER BY TIPO, STATUS;
```

---

## 8. Habilitando novos tipos de documento

Cinco dos sete tipos estão desligados. Para habilitar, descomente a linha em `TIPOS`.

| Tipo | Qtd | Status | Observação |
|---|---|---|---|
| `devolution` | 12 | ✅ ativo | validado |
| `sale_return` | 5 | ✅ ativo | validado |
| `inbound` | 19 | ⚪ desligado | entrada real — afeta estoque |
| `inbound_return` | 11 | ⚪ desligado | entrada real — afeta estoque |
| `symbolic_inbound` | 28 | ⚪ desligado | |
| `symbolic_inbound_return` | 502 | ⚪ desligado | maior volume |
| `sale` | 423 | 🔴 desligado | **risco fiscal — ver abaixo** |

### Ordem recomendada

1. **Não habilite nada** antes de ver uma nota sair de `STATUS 0` para `5`. Ligar tudo
   antes disso é gravar centenas de linhas que podem estar todas erradas do mesmo jeito.
2. Depois de validado, habilite os tipos de entrada e os simbólicos, um por vez, com
   `LIMITE_LOTE` baixo, conferindo a nota gerada.
3. **`sale` por último e só com aval.** São 423 documentos e é o único grupo com risco
   fiscal real. **Pergunta em aberto para o Paulo E a Denise:** as notas de venda já
   entram por outro caminho (DF-e, emissão própria, Tem Api parcial)? Importar venda em
   duplicidade não é erro de teste, é problema fiscal.

---

## 9. Solução de problemas

### `Token da Anymarket nao configurado`

O parâmetro `ANYMARKET_TOKEN` não existe ou está vazio. Crie-o, ou preencha
`TOKEN_FALLBACK` temporariamente para testar.

### `HTTP 400: O limite mínimo permitido por página é de 5 recursos`

`PAGE_SIZE` menor que 5. A API não aceita.

### `HTTP 401` ou `HTTP 403`

Token inválido ou expirado. Um token já foi exposto anteriormente e deve estar
rotacionado — confirme que o parâmetro tem o valor atual.

### `Tipo esperado 'String', tipo recebido 'java.math.BigDecimal'`

Um `setCampo` está mandando número onde a coluna é texto. **O valor exibido num export
não revela o tipo** — `CFOPXML` mostra `1202` e é `VARCHAR2`; `ENTSAINFE` mostra `0` e é
`VARCHAR2(1)`. Consulte:

```sql
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
FROM USER_TAB_COLUMNS
WHERE TABLE_NAME = 'TGFIXN' AND COLUMN_NAME = 'NOME_DO_CAMPO';
```

Regra: `VARCHAR2`/`CHAR`/`CLOB` → `String(x)` · `NUMBER`/`FLOAT` → `Number(x)` ·
`DATE` → objeto `Date`

### `unterminated string literal`

Aspa curva vinda de copiar/colar, ou `\n` dentro de string. Use aspas retas.

### Falha `chave ja existe na TGFIXN`

Não é bug — é a rede de segurança funcionando. Acontece com as notas importadas pela
versão anterior do robô, que usavam o formato antigo `INVOICE-{idOrder}.XML` e por isso
não são reconhecidas pelo dedup por nome.

### Notas ficam em `STATUS = 0` para sempre

**O motor não está processando.** Verifique se as notas que o **próprio Paulo** subiu
pela importação interna também estão em `STATUS 0` — se sim, o problema não é do robô.

Bloqueio conhecido em homologação: tabela `TGFLOCOPER` inexistente e metadados de
`TGFTOP->NFSETIPOPER` não inicializados. Causa provável: base clonada com versão de
aplicação dessincronizada. **É infra, não código.**

### Erro `CNPJ não encontrado` no `DETALHESIMPORTACAO`

O motor **localiza** o parceiro pelo CNPJ/CPF, mas **não cria** se não existir (confirmado
pelo Paulo em 27/08). Pré-checagem:

```sql
SELECT CODPARC, NOMEPARC FROM TGFPAR
WHERE CGC_CPF IS NOT NULL
  AND REGEXP_REPLACE(CGC_CPF, '[^0-9]', '') = '{documento_so_digitos}'
```

`CGC_CPF` é armazenado só com dígitos. O `IS NOT NULL` é obrigatório: sem ele, parceiros
sem documento vazam no resultado (string vazia = NULL no Oracle).

---

## 10. Limitações conhecidas

### Não existe filtro por data

**A API da Anymarket não retorna data na listagem.** Os únicos campos por documento são
`id`, `url`, `marketplace`, `type` e `subType`. O parâmetro `createdAfter` é aceito e
repassado no link de paginação, mas **não filtra nada** — testado em 27/08/2026.

A data só existe dentro do XML (`dhEmi`), então filtrar por período exigiria baixar todos
os ~1000 XMLs para descartar a maioria. Inviável.

**Consequência:** o requisito original "importar os últimos 30 dias" não é implementável.
O dedup entrega o efeito prático desejado de forma melhor: pega o que falta de **qualquer**
época, inclusive documentos retroativos que uma janela de 30 dias perderia.

### A listagem é do mais antigo para o mais novo

Offset 0 é o documento mais antigo da conta. Não dá para parar cedo na varredura — é
preciso percorrer até o fim para achar os novos. É o que torna o dedup em memória
essencial: percorrer é barato, baixar não.

### `CFOPXML` usa o CFOP do primeiro item

Se uma nota tiver itens com CFOPs diferentes, não se sabe qual o Portal escolheria. Sem
impacto conhecido, já que a TOP é deduzida pelo motor.

### `CODEMP` fixo em 1

Débito técnico **consciente**, não desconhecimento: existe um único CNPJ emitente
(`28414558000132`) em todas as 121 notas do histórico do Full, sempre com `CODEMP = 1`.
Se a BeBaby passar a operar o Full por outra empresa, isso precisa virar regra por CNPJ.

### Ainda é ação de tela

Roda como Ação Agendada, mas o gatilho de teste continua sendo o botão da `AD_TESTENOTA`.

---

## 11. Decisões de projeto

Registro do "por quê" de cada escolha não óbvia.

### `CODTIPOPER` não é enviado

Paulo, 27/08: *"Não precisa enviar, porque pode ser mais de uma. Ela pega pelo modelo do
que está no XML — se for dev, venda ou remessa."*

Confirmado pelos dados: a TOP `1766` cobre 2 naturezas × 2 CFOPs (1202 dentro do estado,
2202 fora). Não há mapeamento 1:1 possível. **Enviar limitaria a dedução do motor.**

Efeito colateral positivo: expandir para novos tipos não exige mapeamento de TOP nenhum.

### `TIPONFE` é derivado do `tpNF` — e há um conflito aberto

⚠️ **Paulo disse:** D = Devolução, E = Remessa, V = Venda.
⚠️ **Os dados dizem:** não existe **nenhuma** nota com `'D'` em 121 notas processadas.

Correlação perfeita nas notas em `STATUS 5`:

| `ENTSAINFE` | `TIPONFE` | Qtd |
|---|---|---|
| 1 (saída) | `V` | 93 vendas |
| 0 (entrada) | `E` | 27 devoluções / retornos |

**Decisão adotada:** o campo espelha o `tpNF` do XML (entrada/saída), não a natureza da
operação. Isso também explica o `'E'` na importação interna do Paulo — não foi descuido,
foi o comportamento correto.

**Pendente de confirmação com o Paulo.** Se ele confirmar um caso em que `'D'` é usado, a
função `tipoNfeDe()` é o único ponto a alterar.

### `CNPJPARC` é "o lado que não é a BeBaby"

Nas 121 notas do histórico, `CNPJPARC` é **sempre** igual a `CNPJDEST` — inclusive nas
vendas. Mas isso **não prova a regra**: em venda e devolução do Full a BeBaby é sempre a
emitente, então o outro lado é sempre o destinatário. **Não existe no histórico nenhuma
nota em que a BeBaby seja destinatária.**

O script extrai o CNPJ da BeBaby das posições 7–20 da própria chave de acesso e escolhe o
lado oposto. Assim funciona nos dois sentidos — pré-requisito para habilitar os tipos de
entrada.

### `CONFIG` e `CODPARC` não são preenchidos

São saída do motor, não entrada. Confirmado por dado: `CONFIG` preenchida em 100% das
notas em `STATUS 5` e vazia em 100% das em `STATUS 0`. `CODPARC` idem.

### O prefixo `INVOICE-` foi mantido

O identificador mudou, mas o prefixo não. Preserva as queries de investigação que usam
`LIKE 'INVOICE-%'` e a convenção que a Tem Api usava.

⚠️ **A confirmar com o Paulo:** que o `NOMEARQUIVO` é apenas rótulo e que nada no motor
depende do formato do nome.

### O `getErrorStream()` no `baixa()`

Quando o HTTP não é 2xx, `getInputStream()` estoura antes de ler o corpo — e a mensagem
de erro da API se perde. Foi assim que o limite mínimo de 5 itens por página ficou
invisível por uma rodada inteira. Ler o `getErrorStream()` transforma "deu erro" em "deu
erro porque X".

---

## Referência: a chave de acesso da NF-e

44 dígitos. Posições em base 1 (SQL) — em JavaScript, subtraia 1.

| Posições | Conteúdo | Uso |
|---|---|---|
| 1–2 | cUF (UF do emitente) | — |
| 3–6 | AAMM da emissão | — |
| 7–20 | **CNPJ do emitente** | identificar a BeBaby → `CNPJPARC` |
| 21–22 | modelo (55 = NF-e) | — |
| 23–25 | **série** | → `SERIEDOC` |
| 26–34 | **número da nota** | → `NUMNOTA` |
| 35 | tipo de emissão | — |
| 36–43 | código numérico | — |
| 44 | dígito verificador | — |

Em JavaScript: `ch.substring(6,20)` = CNPJ, `ch.substring(22,25)` = série,
`ch.substring(25,34)` = número.

---

## Arquivos relacionados

| Arquivo | O que é |
|---|---|
| `robo_full_tgfixn_lote.js` | Este robô |
| `estado_projeto_tgfixn_2026-08-27.md` | Handoff completo do projeto: investigação, engenharia reversa, queries |
| `robo_devolucao_full_tgfixn.js` | Versão anterior, uma nota por clique. Mantida como referência |

---

## Contatos

| Pessoa | Papel | Assuntos |
|---|---|---|
| **Paulo Vieira** | Dev terceirizado Sankhya | Motor de importação, TOPs, estrutura fiscal, infra da homologação |
| **Denise** | Operações | Aval sobre importação de notas de venda |
