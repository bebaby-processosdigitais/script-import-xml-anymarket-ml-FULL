// =====================================================================
// ROBO FULL - VERSAO DE TESTE (SIMULACAO)  v3
// Atualizado: 27/08/2026
//
// Mesma logica da versao de producao, mas NAO grava na TGFIXN.
// Grava um relatorio por documento na AD_TESTENOTA para inspecao.
//
// DEDUP EM DOIS ESTAGIOS
//   1) por NOMEARQUIVO  -> antes do download (barato, evita baixar XML)
//   2) por CHAVEACESSO  -> depois do download (pega as notas antigas, que
//      usam o formato de nome anterior INVOICE-{idOrder}.XML)
//
// Ambos os conjuntos ficam em memoria: 2 queries na largada, ZERO por nota.
//
// NAO e preciso consultar a TGFCAB: verificado em 27/08 que ZERO notas do
// Full existem na TGFCAB sem estar na TGFIXN (nota do Full sempre chega
// como XML, e XML sempre entra pela TGFIXN).
//
// SOBRE A COLUNA 'PARCEXISTE' DO RELATORIO:
// Ela NAO indica problema. O motor CADASTRA o parceiro na TGFPAR quando
// nao existe (confirmado por Paulo em 27/08). Um 'N' apenas prevê que
// aquele parceiro sera criado no processamento. Diagnostico de 27/08:
//   tipos de entrada e simbolicos -> 100% dos parceiros ja existem
//   devolution / sale_return      -> maioria sera criada pelo motor
//
// Cole na acao Script "Verificar Parceiro" da AD_TESTENOTA e clique no raio.
// =====================================================================

// ========================================================== INTERRUPTORES
var GRAVAR_TGFIXN = false;   // false = simulacao. NAO toca na TGFIXN.
var GRAVAR_LOG    = true;    // grava o relatorio na AD_TESTENOTA
var CONSIDERA_LOG = true;    // conta o que ja foi simulado como "ja visto"
                             // (util porque nao da pra limpar a AD_TESTENOTA)
var LIMITE_LOTE   = 5;       // notas efetivamente processadas por rodada

// ---------------------------------------------------------- CONFIGURACAO
var PARAM_TOKEN    = "ANYMARKET_TOKEN";
var TOKEN_FALLBACK = "";     // cole o token aqui SO para testar

var CODEMP_FIXO = 1;
var CODUSU_IMP  = 0;
var MAX_PAGINAS = 30;
var PAGE_SIZE   = 50;        // minimo aceito pela API e 5
var FILA_FOLGA  = 4;         // coleta LIMITE_LOTE * FILA_FOLGA candidatas,
                             // porque parte morre no filtro de chave

// Diagnostico de 27/08 (98 docs analisados): os quatro tipos abaixo tem
// 100% dos parceiros ja cadastrados e contraparte CNPJ. Liberados quanto
// a cadastro; so aguardam o motor voltar a processar.
var TIPOS = {
    "devolution":              true,
    "sale_return":             true
    // "inbound":                 true,   // 13 docs  - parceiros OK
    // "inbound_return":          true,   // 11 docs  - parceiros OK
    // "symbolic_inbound":        true,   // 32 docs  - parceiros OK
    // "symbolic_inbound_return": true,   // 522 docs - parceiros OK
    // "sale":                    true    // 476 docs - EXIGE AVAL DE PROCESSO
};

var BASE = "https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents";

// ================================================================ TOKEN
function pegaToken() {
    try {
        var t = getParametroSistema(PARAM_TOKEN);
        if (t != null && String(t) !== "") return String(t);
    } catch (e) { /* parametro nao existe */ }
    if (TOKEN_FALLBACK !== "") return TOKEN_FALLBACK;
    throw "Token nao configurado. Crie o parametro " + PARAM_TOKEN
        + " ou preencha TOKEN_FALLBACK.";
}
var token = pegaToken();

// ================================================================= HTTP
function baixa(endereco, comToken) {
    var url = new java.net.URL(endereco);
    var conn = url.openConnection();
    if (comToken) conn.setRequestProperty("gumgaToken", token);
    conn.setConnectTimeout(15000);
    conn.setReadTimeout(30000);

    var codigo = conn.getResponseCode();
    var stream = (codigo >= 400) ? conn.getErrorStream() : conn.getInputStream();
    if (stream == null) throw "HTTP " + codigo + " sem corpo";

    var sc = new java.util.Scanner(stream, "UTF-8").useDelimiter("\\A");
    var txt = sc.hasNext() ? sc.next() : "";
    sc.close();

    if (codigo >= 400) throw "HTTP " + codigo + ": " + String(txt);
    return String(txt);
}

// ============================================================ UTILITARIOS
function arquivoDaUrl(u) {
    var s = String(u);
    var nome = s.substring(s.lastIndexOf("/") + 1);
    var ponto = nome.lastIndexOf(".xml");
    return (ponto < 0) ? nome : nome.substring(0, ponto);
}
function nomeArquivoDe(doc) {
    return "INVOICE-" + doc.type + "-" + arquivoDaUrl(doc.url) + ".XML";
}
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
// Espelha o tpNF em 100% das 121 notas que processaram (STATUS 5).
// Paulo indicou 'D' para devolucao, mas nao existe 'D' no historico.
function tipoNfeDe(tpNF) { return (String(tpNF) === "1") ? "V" : "E"; }
function corta(txt, max) {
    if (txt == null) return null;
    txt = String(txt);
    return (txt.length > max) ? txt.substring(0, max) : txt;
}
function dataDe(txt) {
    if (txt == null || txt.length < 19) return null;
    return new Date(
        Number(txt.substring(0, 4)), Number(txt.substring(5, 7)) - 1,
        Number(txt.substring(8, 10)), Number(txt.substring(11, 13)),
        Number(txt.substring(14, 16)), Number(txt.substring(17, 19)));
}
function serieDaChave(ch)  { return Number(ch.substring(22, 25)); }
function numeroDaChave(ch) { return Number(ch.substring(25, 34)); }

function achaParceiro(documento) {
    if (documento == null || String(documento) === "") return null;
    var q = getQuery("native");
    q.setParam("doc", String(documento));
    q.nativeSelect("SELECT CODPARC, NOMEPARC FROM TGFPAR "
        + "WHERE CGC_CPF IS NOT NULL "
        + "AND REGEXP_REPLACE(CGC_CPF, '[^0-9]', '') = {doc}");
    if (q.next()) {
        return { cod: Number(q.getString("CODPARC")),
                 nome: String(q.getString("NOMEPARC")) };
    }
    return null;
}

// ==================================================== ETAPA 1 - MEMORIA
// Dois conjuntos, duas queries. Nenhuma consulta por nota depois disso.

// 1a) nomes de arquivo ja importados (dedup pre-download)
var nomesConhecidos = {};
var qtdNomes = 0;
var qNome = getQuery("native");
qNome.nativeSelect("SELECT NOMEARQUIVO FROM TGFIXN WHERE NOMEARQUIVO LIKE 'INVOICE-%'");
while (qNome.next()) {
    nomesConhecidos[String(qNome.getString("NOMEARQUIVO"))] = true;
    qtdNomes++;
}

// 1b) chaves de acesso ja importadas (dedup pos-download)
// Pega TUDO, nao so as INVOICE-: nota que entrou pelo DF-e tambem conta.
var chavesConhecidas = {};
var qtdChaves = 0;
var qChave = getQuery("native");
qChave.nativeSelect("SELECT CHAVEACESSO FROM TGFIXN WHERE CHAVEACESSO IS NOT NULL");
while (qChave.next()) {
    chavesConhecidas[String(qChave.getString("CHAVEACESSO"))] = true;
    qtdChaves++;
}

// 1c) chaves ja simuladas (porque nao da pra limpar a AD_TESTENOTA)
var qtdSimuladas = 0;
if (CONSIDERA_LOG) {
    var qSim = getQuery("native");
    qSim.nativeSelect("SELECT CHAVEACESSO FROM AD_TESTENOTA WHERE CHAVEACESSO IS NOT NULL");
    while (qSim.next()) {
        var c = String(qSim.getString("CHAVEACESSO"));
        if (chavesConhecidas[c] !== true) {
            chavesConhecidas[c] = true;
            qtdSimuladas++;
        }
    }
}

// ==================================================== ETAPA 2 - VARREDURA
// Filtra por tipo e por NOME. Nenhum download acontece aqui.
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

// ==================================================== ETAPA 3 - PROCESSA
// Baixa, extrai, aplica o dedup por CHAVE, e grava o relatorio.
var ok = 0, falhas = 0, semParceiro = 0, pulouChave = 0, gravadasReal = 0;
var erros = "";
var primeira = "";

for (var f = 0; f < fila.length && ok < LIMITE_LOTE; f++) {
    var item = fila[f];
    try {
        var xml = baixa(item.doc.url, false);

        var chave = extrai(xml, "chNFe");
        if (chave == null || chave.length !== 44) throw "chNFe ausente ou invalida";

        // ---- DEDUP ESTAGIO 2: a chave ja existe?
        // Nao e falha: e o filtro funcionando. Nao consome vaga do lote.
        if (chavesConhecidas[chave] === true) {
            pulouChave++;
            continue;
        }
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

        // Parceiro = o lado que NAO e a BeBaby (CNPJ sai da propria chave).
        // ATENCAO: em 98 documentos diagnosticados a BeBaby era SEMPRE a
        // emitente, inclusive nos tipos de entrada. O ramo que escolhe o
        // emitente nunca executou -- logica correta, mas nao validada.
        var cnpjBebaby = chave.substring(6, 20);
        var docParc = (docEmit != null && String(docEmit) === cnpjBebaby)
                    ? docDest : docEmit;
        if (docParc == null) docParc = docDest;

        // Nao e erro: apenas prevê que o motor vai criar este parceiro.
        var parc = achaParceiro(docParc);
        if (parc == null) semParceiro++;

        // resumo compacto (AD_TESTENOTA.STATUS tem 100 chars)
        var resumoCampos =
              tipoNfeDe(tpNF) + tpNF
            + " " + serieDaChave(chave) + "/" + numeroDaChave(chave)
            + " R$" + vNF
            + " C" + cfop
            + " " + corta(natOp, 22)
            + " ref" + (refNFe != null ? "S" : "N")
            + " " + corta(dhEmi, 10);

        if (primeira === "") primeira = resumoCampos;

        if (GRAVAR_LOG) {
            var linha = novaLinha('AD_TESTENOTA');
            linha.setCampo('CHAVEACESSO', corta(chave, 44));
            linha.setCampo('TIPONOTA',    corta(item.doc.type, 30));
            linha.setCampo('DOCPARC',     corta(docParc, 20));
            linha.setCampo('NOMEPARC',    corta(nomeDest, 60));
            linha.setCampo('PARCEXISTE',  (parc == null) ? 'N' : 'S');
            if (parc != null) linha.setCampo('CODPARC', parc.cod);
            linha.setCampo('STATUS',      corta(resumoCampos, 100));
            linha.setCampo('DTIMPORT',    new Date());
            linha.save();
        }

        if (GRAVAR_TGFIXN) {
            var nova = novaLinha('TGFIXN');
            nova.setCampo('XML', xml);
            nova.setCampo('CHAVEACESSO', chave);
            nova.setCampo('NOMEARQUIVO', corta(item.nome, 200));
            nova.setCampo('TIPO', 'N');
            nova.setCampo('STATUS', 0);
            nova.setCampo('CODEMP', CODEMP_FIXO);
            nova.setCampo('DHIMPORT', new Date());
            nova.setCampo('CODUSUIMP', CODUSU_IMP);
            nova.setCampo('TIPONFE', tipoNfeDe(tpNF));
            nova.setCampo('NUMNOTA', numeroDaChave(chave));
            nova.setCampo('SERIEDOC', serieDaChave(chave));
            if (natOp != null) nova.setCampo('NATUREZAOPER', natOp);
            if (cfop  != null) nova.setCampo('CFOPXML', cfop);
            if (tpNF  != null) nova.setCampo('ENTSAINFE', String(tpNF));
            if (vNF      != null) nova.setCampo('VLRNOTA', Number(vNF));
            if (dhEmi    != null) nova.setCampo('DHEMISS', dataDe(dhEmi));
            if (dhRecbto != null) nova.setCampo('DTAUTORIZACAO', dataDe(dhRecbto));
            if (nomeEmit != null) nova.setCampo('XNOMEEMIT', corta(nomeEmit, 60));
            if (nomeDest != null) nova.setCampo('XNOMEDEST', corta(nomeDest, 60));
            if (docDest  != null) nova.setCampo('CNPJDEST', corta(docDest, 14));
            if (docParc  != null) nova.setCampo('CNPJPARC', corta(docParc, 14));
            if (refNFe   != null) {
                nova.setCampo('DOCSREF',
                    '<docsRef><chaveAcesso>' + refNFe + '</chaveAcesso></docsRef>');
            }
            nova.save();
            gravadasReal++;
        }

        ok++;

    } catch (e) {
        falhas++;
        if (erros.length < 600) erros += "[" + corta(item.nome, 40) + "] " + e + " ;; ";
    }
}

// ==================================================== ETAPA 4 - RESUMO
// IMPORTANTE: 'mensagem', NUNCA 'throw'.
// throw faz rollback e apagaria tudo que acabamos de gravar.
var modo = GRAVAR_TGFIXN ? "*** GRAVOU NA TGFIXN ***" : "SIMULACAO (TGFIXN intacta)";

mensagem = modo
    + " || MEMORIA: nomes=" + qtdNomes + " chaves=" + qtdChaves
    + (CONSIDERA_LOG ? " +sim=" + qtdSimuladas : "")
    + " || VARREU: " + vistos
    + " outrostipos=" + ignoradosTipo
    + " pulouNOME=" + pulouNome
    + " fila=" + fila.length
    + " || PROCESSOU: pulouCHAVE=" + pulouChave
    + " NOVAS=" + ok
    + " motorCriara=" + semParceiro
    + " falhas=" + falhas
    + (GRAVAR_TGFIXN ? " gravadas=" + gravadasReal : "")
    + (primeira === "" ? "" : " || 1a: " + primeira)
    + (erros === "" ? "" : " || ERROS: " + erros);
