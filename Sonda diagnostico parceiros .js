// =====================================================================
// SONDA DE DIAGNOSTICO - PARCEIROS FALTANTES POR TIPO
//
// NAO grava na TGFIXN. NAO gera uma linha de log por documento.
// Baixa os XMLs, checa se o parceiro existe na TGFPAR, e devolve
// numeros agregados por tipo.
//
// Objetivo: saber o TAMANHO do problema antes de habilitar tipos novos.
// =====================================================================

var TOKEN_FALLBACK = "";     // cole o token aqui
var PARAM_TOKEN    = "ANYMARKET_TOKEN";

// Tipos a diagnosticar (todos, menos 'sale' que e risco fiscal)
var TIPOS = {
    "devolution":              true,
    "sale_return":             true,
    "inbound":                 true,
    "inbound_return":          true,
    "symbolic_inbound":        true,
    "symbolic_inbound_return": true
};

var MAX_DOCS_POR_TIPO = 25;   // amostra por tipo (nao baixa os 530)
var MAX_PAGINAS = 30;
var PAGE_SIZE   = 50;
var GRAVAR_LOG  = true;       // UMA linha na AD_TESTENOTA com o resultado

var BASE = "https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents";
var CNPJ_BEBABY = "28414558000132";

// ---------------------------------------------------------------- setup
function pegaToken() {
    try {
        var t = getParametroSistema(PARAM_TOKEN);
        if (t != null && String(t) !== "") return String(t);
    } catch (e) { }
    if (TOKEN_FALLBACK !== "") return TOKEN_FALLBACK;
    throw "Token nao configurado.";
}
var token = pegaToken();

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
function corta(txt, max) {
    if (txt == null) return null;
    txt = String(txt);
    return (txt.length > max) ? txt.substring(0, max) : txt;
}
function existeParceiro(documento) {
    if (documento == null || String(documento) === "") return false;
    var q = getQuery("native");
    q.setParam("doc", String(documento));
    q.nativeSelect("SELECT COUNT(*) AS QTD FROM TGFPAR "
        + "WHERE CGC_CPF IS NOT NULL "
        + "AND REGEXP_REPLACE(CGC_CPF, '[^0-9]', '') = {doc}");
    q.next();
    return Number(q.getString("QTD")) > 0;
}

// ============================================ ETAPA 1 - monta a amostra
var amostra = {};   // tipo -> lista de urls
var contagemTotal = {};
var paginas = 0, vistos = 0;

while (paginas < MAX_PAGINAS) {
    var dados = JSON.parse(baixa(
        BASE + "?limit=" + PAGE_SIZE + "&offset=" + (paginas * PAGE_SIZE), true));
    var lista = dados.content;
    if (lista == null || lista.length === 0) break;

    for (var i = 0; i < lista.length; i++) {
        vistos++;
        var t = String(lista[i].type);

        if (contagemTotal[t] == null) contagemTotal[t] = 0;
        contagemTotal[t]++;

        if (TIPOS[t] !== true) continue;
        if (amostra[t] == null) amostra[t] = [];
        if (amostra[t].length < MAX_DOCS_POR_TIPO) {
            amostra[t].push(lista[i].url);
        }
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

// ============================================ ETAPA 2 - baixa e analisa
var relatorio = "";
var totalAnalisado = 0, totalSemParc = 0;

for (var tipo in amostra) {
    var urls = amostra[tipo];
    var n = 0, semParc = 0, cpfs = 0, cnpjs = 0, bebabyEmit = 0, erros = 0;
    var exemploFalta = "";

    for (var k = 0; k < urls.length; k++) {
        try {
            var xml = baixa(urls[k], false);
            var chave = extrai(xml, "chNFe");
            if (chave == null || chave.length !== 44) throw "sem chave";

            var bEmit = bloco(xml, "emit");
            var bDest = bloco(xml, "dest");
            var docEmit = docDoBloco(bEmit);
            var docDest = docDoBloco(bDest);

            // quem e a BeBaby nesta nota?
            if (docEmit != null && String(docEmit) === CNPJ_BEBABY) bebabyEmit++;

            // parceiro = o lado que NAO e a BeBaby
            var docParc = (docEmit != null && String(docEmit) === CNPJ_BEBABY)
                        ? docDest : docEmit;
            if (docParc == null) docParc = docDest;

            if (docParc != null) {
                if (String(docParc).length === 11) cpfs++; else cnpjs++;
            }

            n++;
            if (!existeParceiro(docParc)) {
                semParc++;
                if (exemploFalta === "") {
                    exemploFalta = String(docParc) + "/"
                        + corta(extrai(bDest, "xNome"), 18);
                }
            }
        } catch (e) {
            erros++;
        }
    }

    totalAnalisado += n;
    totalSemParc += semParc;

    relatorio += tipo.substring(0, 14)
        + " tot=" + contagemTotal[tipo]
        + " am=" + n
        + " SEMPARC=" + semParc
        + " cpf=" + cpfs + " cnpj=" + cnpjs
        + " bbEmit=" + bebabyEmit
        + (erros > 0 ? " err=" + erros : "")
        + (exemploFalta === "" ? "" : " ex:" + exemploFalta)
        + "  ||  ";
}

// tipos que existem na conta mas nao foram analisados
var outros = "";
for (var tt in contagemTotal) {
    if (TIPOS[tt] !== true) outros += tt.substring(0, 12) + "=" + contagemTotal[tt] + " ";
}

var pct = (totalAnalisado === 0) ? 0
        : Math.round((totalSemParc * 100) / totalAnalisado);

var cabecalho = "DIAGNOSTICO PARCEIROS || docs vistos=" + vistos
    + " | analisados=" + totalAnalisado
    + " | SEM PARCEIRO=" + totalSemParc + " (" + pct + "%)"
    + " || NAO analisados: " + outros
    + " || ";

// ------------------------------------------------------------- log unico
if (GRAVAR_LOG) {
    try {
        var log = novaLinha('AD_TESTENOTA');
        log.setCampo('TIPONOTA', corta('DIAG PARCEIRO', 30));
        log.setCampo('STATUS', corta(cabecalho, 100));
        log.setCampo('NOMEPARC', corta(relatorio, 60));
        log.setCampo('DTIMPORT', new Date());
        log.save();
    } catch (eLog) { }
}

mensagem = cabecalho + relatorio;
