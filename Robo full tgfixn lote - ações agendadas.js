// =====================================================================
// ROBO DE IMPORTACAO FULL  (Anymarket -> Sankhya TGFIXN)  -  VERSAO LOTE
// Desenhado para rodar em Acoes Agendadas (sem usuario, sem linha selecionada)
//
// Dedup: NOMEARQUIVO = INVOICE-{type}-{idArquivo}.XML
//        onde idArquivo vem do nome do arquivo na URL do S3
//        (unico em 100% dos documentos - validado por sonda em 27/08/2026)
//
// NAO baixa XML de documento ja importado. O filtro e em memoria.
// =====================================================================

// --------------------------------------------------------- CONFIGURACAO
var PARAM_TOKEN   = "ANYMARKET_TOKEN";   // nome do parametro do sistema
var TOKEN_FALLBACK = "";                 // deixe vazio em producao

var CODEMP_FIXO   = 1;
var CODUSU_IMP    = 0;
var LIMITE_LOTE   = 40;      // notas gravadas por rodada (evita timeout)
var MAX_PAGINAS   = 30;      // paginas de listagem varridas por rodada
var PAGE_SIZE     = 50;      // minimo aceito pela API e 5

// Tipos habilitados. Descomente conforme cada um for validado.
var TIPOS = {
    "devolution":              true,
    "sale_return":             true
    // "inbound":                 true,   // entrada real - afeta estoque
    // "inbound_return":          true,   // entrada real - afeta estoque
    // "symbolic_inbound":        true,
    // "symbolic_inbound_return": true,
    // "sale":                    true    // RISCO FISCAL - exige aval Paulo + Denise
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
// Le o corpo da resposta MESMO em erro (getErrorStream), senao a mensagem
// da API se perde e o diagnostico fica cego.
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
// .../transactionType-devolution/259061706.6606158899.xml -> 259061706.6606158899
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

// TIPONFE espelha o tpNF em 100% das 121 notas que processaram (STATUS 5).
// Paulo indicou 'D' para devolucao, mas nao existe 'D' no historico. A confirmar.
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

function serieDaChave(ch) { return Number(ch.substring(22, 25)); }
function numeroDaChave(ch) { return Number(ch.substring(25, 34)); }

// ============================================================ ETAPA 1
// Carrega em memoria TUDO que ja foi importado. Uma query, nao N.
var jaImportados = {};
var qtdConhecidos = 0;

var qExist = getQuery("native");
qExist.nativeSelect("SELECT NOMEARQUIVO FROM TGFIXN WHERE NOMEARQUIVO LIKE 'INVOICE-%'");
while (qExist.next()) {
    jaImportados[String(qExist.getString("NOMEARQUIVO"))] = true;
    qtdConhecidos++;
}

// ============================================================ ETAPA 2
// Varre a listagem e monta a fila de novos. NENHUM download aqui.
var fila = [];
var paginas = 0, vistos = 0, ignoradosTipo = 0, jaTinha = 0;

while (paginas < MAX_PAGINAS && fila.length < LIMITE_LOTE) {
    var bruto = baixa(BASE + "?limit=" + PAGE_SIZE + "&offset=" + (paginas * PAGE_SIZE), true);
    var dados = JSON.parse(bruto);
    var lista = dados.content;
    if (lista == null || lista.length === 0) break;

    for (var i = 0; i < lista.length; i++) {
        vistos++;
        var doc = lista[i];

        if (TIPOS[doc.type] !== true) { ignoradosTipo++; continue; }

        var nome = nomeArquivoDe(doc);
        if (jaImportados[nome] === true) { jaTinha++; continue; }

        jaImportados[nome] = true;          // evita duplicata dentro da propria rodada
        fila.push({ doc: doc, nome: nome });
        if (fila.length >= LIMITE_LOTE) break;
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
// Baixa e grava, uma por uma, isoladas. Um XML ruim nao derruba o lote.
var gravadas = 0, falhas = 0;
var erros = "";

for (var f = 0; f < fila.length; f++) {
    var item = fila[f];
    try {
        var xml = baixa(item.doc.url, false);

        var chave = extrai(xml, "chNFe");
        if (chave == null || chave.length !== 44) {
            throw "chNFe ausente ou invalida";
        }

        // Rede de seguranca: se a chave ja existe, nao grava.
        // O dedup principal e por NOMEARQUIVO; este e o cinto extra.
        var dup = getQuery("native");
        dup.setParam("chave", chave);
        dup.nativeSelect("SELECT COUNT(*) AS QTD FROM TGFIXN WHERE CHAVEACESSO = {chave}");
        dup.next();
        if (Number(dup.getString("QTD")) > 0) {
            throw "chave ja existe na TGFIXN";
        }

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

        // O parceiro e SEMPRE o lado que nao e a BeBaby.
        // Nas 121 notas do historico a BeBaby era sempre a emitente, entao
        // CNPJPARC == CNPJDEST. Nos tipos de entrada isso se inverte.
        var cnpjBebaby = chave.substring(6, 20);
        var docParc = (docEmit != null && String(docEmit) === cnpjBebaby) ? docDest : docEmit;
        if (docParc == null) docParc = docDest;

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

        // CODTIPOPER NAO se envia: o motor deduz a TOP pelo modelo do XML (Paulo 27/08)
        if (natOp != null) nova.setCampo('NATUREZAOPER', natOp);
        if (cfop  != null) nova.setCampo('CFOPXML', cfop);
        if (tpNF  != null) nova.setCampo('ENTSAINFE', String(tpNF));   // VARCHAR2(1)

        if (vNF      != null) nova.setCampo('VLRNOTA', Number(vNF));
        if (dhEmi    != null) nova.setCampo('DHEMISS', dataDe(dhEmi));
        if (dhRecbto != null) nova.setCampo('DTAUTORIZACAO', dataDe(dhRecbto));

        if (nomeEmit != null) nova.setCampo('XNOMEEMIT', corta(nomeEmit, 60));
        if (nomeDest != null) nova.setCampo('XNOMEDEST', corta(nomeDest, 60));
        if (docDest  != null) nova.setCampo('CNPJDEST', corta(docDest, 14));
        if (docParc  != null) nova.setCampo('CNPJPARC', corta(docParc, 14));

        if (refNFe != null) {
            nova.setCampo('DOCSREF',
                '<docsRef><chaveAcesso>' + refNFe + '</chaveAcesso></docsRef>');
        }

        nova.save();
        gravadas++;

    } catch (e) {
        falhas++;
        if (erros.length < 900) {
            erros += item.nome + " => " + e + "  //  ";
        }
    }
}

// ============================================================ ETAPA 4
// Log. Em acao agendada nao existe usuario, entao 'mensagem' pode nao aparecer:
// o registro fica gravado na AD_TESTENOTA.
var resumo = "Conhecidos: " + qtdConhecidos
           + " | Vistos: " + vistos
           + " | Outros tipos: " + ignoradosTipo
           + " | Ja tinha: " + jaTinha
           + " | Fila: " + fila.length
           + " | GRAVADAS: " + gravadas
           + " | FALHAS: " + falhas;

try {
    var log = novaLinha('AD_TESTENOTA');
    log.setCampo('TIPONOTA', corta('ROBO LOTE', 60));
    log.setCampo('STATUS', corta(resumo, 200));
    log.setCampo('NOMEPARC', corta(erros === "" ? "sem erros" : erros, 200));
    log.setCampo('DTIMPORT', new Date());
    log.save();
} catch (eLog) {
    // se a AD_TESTENOTA nao aceitar o log, nao derruba o lote ja gravado
}

mensagem = resumo + (erros === "" ? "" : "  ///  ERROS: " + erros);
