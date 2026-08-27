// =====================================================================
// ROBO DE IMPORTACAO FULL  (Anymarket -> Sankhya TGFIXN)
// VERSAO DE PRODUCAO - para rodar em ACOES AGENDADAS
//
// Atualizado: 27/08/2026
//
// Dedup em DOIS ESTAGIOS, ambos em memoria (2 queries na largada,
// ZERO consultas por nota):
//   1) NOMEARQUIVO  -> antes do download. Evita baixar XML conhecido.
//   2) CHAVEACESSO  -> depois do download. Pega as notas antigas, que
//      usam o formato de nome anterior (INVOICE-{idOrder}.XML), e as
//      que entraram pelo DF-e ou por importacao manual.
//
// Confirmado em 27/08: a TGFIXN e o universo COMPLETO das notas do Full.
// Nota do Full sempre chega como XML, e XML sempre entra pela TGFIXN.
// Query de verificacao retornou ZERO notas do Full que existem na
// TGFCAB sem estar na TGFIXN. Nao e preciso consultar a TGFCAB.
// =====================================================================

// --------------------------------------------------------- CONFIGURACAO
var PARAM_TOKEN    = "ANYMARKET_TOKEN";   // parametro do sistema com o token
var TOKEN_FALLBACK = "";                  // DEIXE VAZIO EM PRODUCAO

var CODEMP_FIXO = 1;      // unico CNPJ emitente no Full (28414558000132)
var CODUSU_IMP  = 0;      // irrelevante: qualquer valor processa
var LIMITE_LOTE = 40;     // notas gravadas por rodada (evita timeout)
var MAX_PAGINAS = 30;     // paginas de listagem varridas por rodada
var PAGE_SIZE   = 50;     // minimo aceito pela API e 5
var FILA_FOLGA  = 4;      // coleta LIMITE_LOTE * FILA_FOLGA candidatas,
                          // porque parte morre no dedup por chave

// Tipos habilitados. Diagnostico de 27/08 (98 documentos analisados):
//   inbound, inbound_return, symbolic_inbound, symbolic_inbound_return
//   -> 74 docs, 100% dos parceiros ja cadastrados, contraparte CNPJ.
//      Liberados quanto a cadastro; aguardando apenas o motor voltar.
//   devolution, sale_return -> contraparte CPF (consumidor final).
//      O motor cadastra o parceiro sozinho na TGFPAR (Paulo, 27/08).
//   sale -> 476 docs. Ver README secao 8 antes de habilitar.
var TIPOS = {
    "devolution":              true,
    "sale_return":             true
    // "inbound":                 true,   // 13 docs - parceiros OK
    // "inbound_return":          true,   // 11 docs - parceiros OK
    // "symbolic_inbound":        true,   // 32 docs - parceiros OK
    // "symbolic_inbound_return": true,   // 522 docs - parceiros OK
    // "sale":                    true    // 476 docs - EXIGE AVAL DE PROCESSO
};

var BASE = "https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents";

// ---------------------------------------------------------------- TOKEN
function pegaToken() {
    try {
        var t = getParametroSistema(PARAM_TOKEN);
        if (t != null && String(t) !== "") return String(t);
    } catch (e) { /* parametro nao existe nesta base */ }
    if (TOKEN_FALLBACK !== "") return TOKEN_FALLBACK;
    throw "Token da Anymarket nao configurado. Crie o parametro " + PARAM_TOKEN + ".";
}
var token = pegaToken();

// ----------------------------------------------------------------- HTTP
// Le o corpo da resposta MESMO em erro (getErrorStream). Sem isso a
// mensagem da API se perde e o diagnostico fica cego.
function baixa(endereco, comToken) {
    var url = new java.net.URL(endereco);
    var conn = url.openConnection();
    if (comToken) conn.setRequestProperty("gumgaToken", token);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(30000);

    var codigo = conn.getResponseCode();
    var stream = (codigo >= 400) ? conn.getErrorStream() : conn.getInputStream();
    if (stream == null) throw "HTTP " + codigo + " sem corpo em: " + endereco;

    var sc = new java.util.Scanner(stream, "UTF-8").useDelimiter("\\A");
    var txt = sc.hasNext() ? sc.next() : "";
    sc.close();

    if (codigo >= 400) throw "HTTP " + codigo + ": " + String(txt);
    return String(txt);
}

// ----------------------------------------------------------- IDENTIDADE
// Identificador universal: o nome do arquivo na URL do S3.
// Unico em 100% dos documentos (sonda de 27/08, conta inteira).
// Necessario porque nenhum campo da listagem existe em todos os tipos:
// 'id' falta nos 'sale'; 'idOrder' falta nos 'symbolic_inbound_return'.
// .../transactionType-devolution/259061706.6606158899.xml
function arquivoDaUrl(u) {
    var s = String(u);
    var nome = s.substring(s.lastIndexOf("/") + 1);
    var ponto = nome.lastIndexOf(".xml");
    return (ponto < 0) ? nome : nome.substring(0, ponto);
}
function nomeArquivoDe(doc) {
    return "INVOICE-" + doc.type + "-" + arquivoDaUrl(doc.url) + ".XML";
}

// -------------------------------------------------------- EXTRACAO XML
function extrai(texto, tag) {
    var abre = "<" + tag + ">", fecha = "</" + tag + ">";
    var ini = texto.indexOf(abre);
    if (ini < 0) return null;
    ini += abre.length;
    var fim = texto.indexOf(fecha, ini);
    return (fim < 0) ? null : texto.substring(ini, fim);
}
function bloco(texto, tag) {
    var abre = "<" + tag + ">", fecha = "</" + tag + ">";
    var ini = texto.indexOf(abre);
    if (ini < 0) return "";
    var fim = texto.indexOf(fecha, ini);
    return (fim < 0) ? "" : texto.substring(ini, fim + fecha.length);
}
function docDoBloco(b) {
    var d = extrai(b, "CNPJ");
    if (d == null) d = extrai(b, "CPF");
    return d;
}

// TIPONFE espelha o tpNF em 100% das 121 notas que processaram (STATUS 5):
//   tpNF 0 (entrada) -> 'E'   |   tpNF 1 (saida) -> 'V'
// Paulo indicou 'D' para devolucao, mas nao existe 'D' no historico.
// Se ele confirmar um caso de 'D', esta funcao e o unico ponto a alterar.
function tipoNfeDe(tpNF) {
    return (String(tpNF) === "1") ? "V" : "E";
}

function corta(txt, max) {
    if (txt == null) return null;
    txt = String(txt);
    return (txt.length > max) ? txt.substring(0, max) : txt;
}

function dataDe(txt) {
    if (txt == null || txt.length < 19) return null;
    return new Date(
        Number(txt.substring(0, 4)),
        Number(txt.substring(5, 7)) - 1,
        Number(txt.substring(8, 10)),
        Number(txt.substring(11, 13)),
        Number(txt.substring(14, 16)),
        Number(txt.substring(17, 19))
    );
}

// A chave carrega serie e numero:
// cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
function serieDaChave(ch)  { return Number(ch.substring(22, 25)); }
function numeroDaChave(ch) { return Number(ch.substring(25, 34)); }

// ============================================================ ETAPA 1
// Carrega em memoria o que ja existe. Duas queries, nao N.
var nomesConhecidos = {};
var qtdNomes = 0;
var qNome = getQuery("native");
qNome.nativeSelect("SELECT NOMEARQUIVO FROM TGFIXN WHERE NOMEARQUIVO LIKE 'INVOICE-%'");
while (qNome.next()) {
    nomesConhecidos[String(qNome.getString("NOMEARQUIVO"))] = true;
    qtdNomes++;
}

// Todas as chaves, sem filtro de origem: pega Tem Api, DF-e, manual e robo.
var chavesConhecidas = {};
var qtdChaves = 0;
var qChave = getQuery("native");
qChave.nativeSelect("SELECT CHAVEACESSO FROM TGFIXN WHERE CHAVEACESSO IS NOT NULL");
while (qChave.next()) {
    chavesConhecidas[String(qChave.getString("CHAVEACESSO"))] = true;
    qtdChaves++;
}

// ============================================================ ETAPA 2
// Varre a listagem e monta a fila. NENHUM download acontece aqui.
var FILA_MAX = LIMITE_LOTE * FILA_FOLGA;
var fila = [];
var paginas = 0, vistos = 0, ignoradosTipo = 0, pulouNome = 0;

while (paginas < MAX_PAGINAS && fila.length < FILA_MAX) {
    var dados = JSON.parse(baixa(
        BASE + "?limit=" + PAGE_SIZE + "&offset=" + (paginas * PAGE_SIZE), true));
    var lista = dados.content;
    if (lista == null || lista.length === 0) break;

    for (var i = 0; i < lista.length; i++) {
        vistos++;
        var doc = lista[i];

        if (TIPOS[doc.type] !== true) { ignoradosTipo++; continue; }

        var nomeArq = nomeArquivoDe(doc);
        if (nomesConhecidos[nomeArq] === true) { pulouNome++; continue; }

        nomesConhecidos[nomeArq] = true;   // nao repete na propria rodada
        fila.push({ doc: doc, nome: nomeArq });
        if (fila.length >= FILA_MAX) break;
    }

    var temNext = false;
    if (dados.links != null) {
        for (var j = 0; j < dados.links.length; j++) {
            if (dados.links[j].rel === "next") temNext = true;
        }
    }
    if (!temNext) break;
    paginas++;
}

// ============================================================ ETAPA 3
// Baixa, aplica o dedup por chave, e grava. Cada nota isolada:
// um XML ruim nao derruba as outras.
var gravadas = 0, falhas = 0, pulouChave = 0, semParceiro = 0;
var erros = "";

for (var f = 0; f < fila.length && gravadas < LIMITE_LOTE; f++) {
    var item = fila[f];
    try {
        var xml = baixa(item.doc.url, false);

        var chave = extrai(xml, "chNFe");
        if (chave == null || chave.length !== 44) throw "chNFe ausente ou invalida";

        // DEDUP ESTAGIO 2 -- nao e falha, e o filtro funcionando
        if (chavesConhecidas[chave] === true) { pulouChave++; continue; }
        chavesConhecidas[chave] = true;

        var bEmit = bloco(xml, "emit");
        var bDest = bloco(xml, "dest");

        var nomeEmit = extrai(bEmit, "xNome");
        var nomeDest = extrai(bDest, "xNome");
        var docEmit  = docDoBloco(bEmit);
        var docDest  = docDoBloco(bDest);

        var natOp    = extrai(xml, "natOp");
        var cfop     = extrai(xml, "CFOP");
        var tpNF     = extrai(xml, "tpNF");
        var vNF      = extrai(xml, "vNF");
        var dhEmi    = extrai(xml, "dhEmi");
        var dhRecbto = extrai(xml, "dhRecbto");
        var refNFe   = extrai(xml, "refNFe");

        // O parceiro e o lado que NAO e a BeBaby. O CNPJ dela sai da
        // propria chave de acesso, entao a regra vale para qualquer tipo.
        // ATENCAO: em 98 documentos diagnosticados a BeBaby era SEMPRE a
        // emitente, inclusive nos tipos de entrada. O ramo que escolhe o
        // emitente nunca executou -- logica correta, mas nao validada.
        var cnpjBebaby = chave.substring(6, 20);
        var docParc = (docEmit != null && String(docEmit) === cnpjBebaby)
                    ? docDest : docEmit;
        if (docParc == null) docParc = docDest;

        var nova = novaLinha('TGFIXN');

        // identificacao
        nova.setCampo('XML', xml);
        nova.setCampo('CHAVEACESSO', chave);
        nova.setCampo('NOMEARQUIVO', corta(item.nome, 200));
        nova.setCampo('TIPO', 'N');
        nova.setCampo('STATUS', 0);
        nova.setCampo('CODEMP', CODEMP_FIXO);
        nova.setCampo('DHIMPORT', new Date());
        nova.setCampo('CODUSUIMP', CODUSU_IMP);
        nova.setCampo('TIPONFE', tipoNfeDe(tpNF));

        // numeracao (derivada da chave)
        nova.setCampo('NUMNOTA', numeroDaChave(chave));
        nova.setCampo('SERIEDOC', serieDaChave(chave));

        // operacao fiscal
        // CODTIPOPER NAO se envia: o motor deduz a TOP pelo modelo do XML
        // (Paulo, 27/08). A TOP 1766 cobre 2 naturezas x 2 CFOPs, entao
        // nao existe mapeamento 1:1 possivel -- enviar limitaria a deducao.
        if (natOp != null) nova.setCampo('NATUREZAOPER', natOp);
        if (cfop  != null) nova.setCampo('CFOPXML', cfop);
        if (tpNF  != null) nova.setCampo('ENTSAINFE', String(tpNF));  // VARCHAR2(1)

        // valores e datas
        if (vNF      != null) nova.setCampo('VLRNOTA', Number(vNF));
        if (dhEmi    != null) nova.setCampo('DHEMISS', dataDe(dhEmi));
        if (dhRecbto != null) nova.setCampo('DTAUTORIZACAO', dataDe(dhRecbto));

        // partes. CODPARC nao se seta: o motor localiza e, se nao existir,
        // CADASTRA o parceiro na TGFPAR (confirmado por Paulo em 27/08).
        if (nomeEmit != null) nova.setCampo('XNOMEEMIT', corta(nomeEmit, 60));
        if (nomeDest != null) nova.setCampo('XNOMEDEST', corta(nomeDest, 60));
        if (docDest  != null) nova.setCampo('CNPJDEST', corta(docDest, 14));
        if (docParc  != null) nova.setCampo('CNPJPARC', corta(docParc, 14));

        // documento referenciado (a venda original que gerou a devolucao)
        if (refNFe != null) {
            nova.setCampo('DOCSREF',
                '<docsRef><chaveAcesso>' + refNFe + '</chaveAcesso></docsRef>');
        }

        nova.save();
        gravadas++;

    } catch (e) {
        falhas++;
        if (erros.length < 600) erros += "[" + corta(item.nome, 40) + "] " + e + " ;; ";
    }
}

// ============================================================ ETAPA 4
// Log. Em acao agendada nao existe usuario, entao 'mensagem' pode nao
// aparecer em lugar nenhum -- o registro fica na AD_TESTENOTA.
var resumo = "n=" + qtdNomes + " c=" + qtdChaves
           + " vis=" + vistos
           + " outros=" + ignoradosTipo
           + " pNome=" + pulouNome
           + " fila=" + fila.length
           + " pChave=" + pulouChave
           + " GRAV=" + gravadas
           + " falhas=" + falhas;

try {
    var log = novaLinha('AD_TESTENOTA');
    log.setCampo('TIPONOTA', corta('ROBO LOTE', 30));
    log.setCampo('STATUS',   corta(resumo, 100));
    log.setCampo('NOMEPARC', corta(erros === "" ? "sem erros" : erros, 60));
    log.setCampo('DTIMPORT', new Date());
    log.save();
} catch (eLog) {
    // se o log falhar, nao derruba o lote ja gravado
}

// IMPORTANTE: 'mensagem', NUNCA 'throw'.
// throw faz rollback e apagaria tudo que acabou de ser gravado.
mensagem = resumo + (erros === "" ? "" : "  ||  ERROS: " + erros);
