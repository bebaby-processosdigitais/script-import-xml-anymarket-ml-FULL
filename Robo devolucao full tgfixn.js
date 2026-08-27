// =====================================================================
// ROBO DE IMPORTACAO DE DEVOLUCOES FULL  (Anymarket -> TGFIXN)
// Versao: paridade de campos com a importacao interna (gabarito 112625)
// Cole na acao "Verificar Parceiro" da AD_TESTENOTA
// =====================================================================

var token = "cole_o_token_NOVO";     // ideal: getParametroSistema(...)
var CODEMP_FIXO   = 1;
var CODUSU_IMP    = 0;               // gabarito 112625 = 0 (SUP = usuario da sessao)
var MAX_PAGINAS   = 30;

// ---------------------------------------------------------------- HTTP
function baixa(endereco, comToken) {
    var url = new java.net.URL(endereco);
    var conn = url.openConnection();
    if (comToken) conn.setRequestProperty("gumgaToken", token);
    conn.setConnectTimeout(15000);
    var sc = new java.util.Scanner(conn.getInputStream(), "UTF-8").useDelimiter("\\A");
    var txt = sc.hasNext() ? sc.next() : "";
    sc.close();
    return String(txt);
}

// ------------------------------------------------------- EXTRACAO XML
// Pega o conteudo da primeira ocorrencia de uma tag simples
function extrai(texto, tag) {
    var abre = "<" + tag + ">", fecha = "</" + tag + ">";
    var ini = texto.indexOf(abre);
    if (ini < 0) return null;
    ini += abre.length;
    var fim = texto.indexOf(fecha, ini);
    return (fim < 0) ? null : texto.substring(ini, fim);
}

// Recorta um bloco inteiro (ex.: <emit>...</emit>) para buscar dentro dele
function bloco(texto, tag) {
    var abre = "<" + tag + ">", fecha = "</" + tag + ">";
    var ini = texto.indexOf(abre);
    if (ini < 0) return "";
    var fim = texto.indexOf(fecha, ini);
    return (fim < 0) ? "" : texto.substring(ini, fim + fecha.length);
}

// TIPONFE espelha o tpNF do XML nas 121 notas que processaram (STATUS 5):
//   tpNF 0 (entrada / devolucao) -> 'E'    tpNF 1 (saida / venda) -> 'V'
// Paulo indicou 'D' para devolucao, mas nao existe 'D' no historico. A confirmar.
function tipoNfeDe(tpNF) {
    return (String(tpNF) === "1") ? "V" : "E";
}

// Corta texto no tamanho maximo da coluna (evita estourar VARCHAR2)
function corta(txt, max) {
    if (txt == null) return null;
    txt = String(txt);
    return (txt.length > max) ? txt.substring(0, max) : txt;
}

// Converte "2026-08-25T17:12:00-03:00" em Date
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

// A chave de acesso carrega serie e numero da nota:
// cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1)
function serieDaChave(ch) { return Number(ch.substring(22, 25)); }
function numeroDaChave(ch) { return Number(ch.substring(25, 34)); }

// ------------------------------------------- VARREDURA DA ANYMARKET
var offset = 0, limit = 50, paginas = 0;
var alvo = null, chaveAlvo = null;

while (paginas < MAX_PAGINAS && alvo == null) {
    var dados = JSON.parse(baixa(
        "https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents?limit="
        + limit + "&offset=" + offset, true));
    var lista = dados.content;
    if (lista == null || lista.length === 0) break;

    for (var i = 0; i < lista.length; i++) {
        var t = lista[i].type;
        if (t === "devolution" || t === "sale_return") {
            var xmlTmp = baixa(lista[i].url, false);
            var ch = extrai(xmlTmp, "chNFe");
            var dup = getQuery("native");
            dup.setParam("chave", ch);
            dup.nativeSelect("SELECT COUNT(*) AS QTD FROM TGFIXN WHERE CHAVEACESSO = {chave}");
            dup.next();
            if (Number(dup.getString("QTD")) === 0) {
                alvo = lista[i];
                chaveAlvo = ch;
                break;
            }
        }
    }

    var temNext = false;
    if (dados.links != null) {
        for (var j = 0; j < dados.links.length; j++) {
            if (dados.links[j].rel === "next") temNext = true;
        }
    }
    if (!temNext) break;
    offset += limit;
    paginas++;
}

if (alvo == null) {
    throw "Nenhuma devolucao NOVA encontrada (todas ja estao na TGFIXN, ou nao ha nenhuma).";
}

// ------------------------------------------------- LEITURA DOS DADOS
var xml     = baixa(alvo.url, false);
var idOrder = alvo.idOrder;

var blocoEmit = bloco(xml, "emit");
var blocoDest = bloco(xml, "dest");

var nomeEmit = extrai(blocoEmit, "xNome");
var nomeDest = extrai(blocoDest, "xNome");

// destinatario pode ser CNPJ (PJ) ou CPF (consumidor final)
var docDest = extrai(blocoDest, "CNPJ");
if (docDest == null) docDest = extrai(blocoDest, "CPF");

var natOp     = extrai(xml, "natOp");
var cfop      = extrai(xml, "CFOP");          // CFOP do 1o item
var tpNF      = extrai(xml, "tpNF");          // 0 = entrada, 1 = saida
var vNF       = extrai(xml, "vNF");
var dhEmi     = extrai(xml, "dhEmi");
var dhRecbto  = extrai(xml, "dhRecbto");      // autorizacao (protNFe)
var refNFe    = extrai(xml, "refNFe");        // chave da venda original

// ------------------------------------------------------- GRAVACAO
var nova = novaLinha('TGFIXN');

// --- identificacao do arquivo
nova.setCampo('XML', xml);
nova.setCampo('CHAVEACESSO', chaveAlvo);
nova.setCampo('NOMEARQUIVO', 'INVOICE-' + idOrder + '.XML');
nova.setCampo('TIPO', 'N');
nova.setCampo('STATUS', 0);
nova.setCampo('CODEMP', CODEMP_FIXO);
nova.setCampo('DHIMPORT', new Date());
nova.setCampo('CODUSUIMP', CODUSU_IMP);
nova.setCampo('TIPONFE', tipoNfeDe(tpNF));

// --- numeracao (derivada da chave de acesso)
nova.setCampo('NUMNOTA', numeroDaChave(chaveAlvo));
nova.setCampo('SERIEDOC', serieDaChave(chaveAlvo));

// --- operacao fiscal
// CODTIPOPER NAO se envia: Paulo 27/08 confirmou que o motor deduz a TOP
// pelo modelo do XML (devolucao / venda / remessa). Enviar limitaria a deducao.
if (natOp != null) nova.setCampo('NATUREZAOPER', natOp);
if (cfop  != null) nova.setCampo('CFOPXML', cfop);
if (tpNF  != null) nova.setCampo('ENTSAINFE', String(tpNF));   // String! guarda "0"/"1"

// --- valores e datas
if (vNF      != null) nova.setCampo('VLRNOTA', Number(vNF));
if (dhEmi    != null) nova.setCampo('DHEMISS', dataDe(dhEmi));
if (dhRecbto != null) nova.setCampo('DTAUTORIZACAO', dataDe(dhRecbto));

// --- partes envolvidas (nomes e documentos; CODPARC fica pro motor)
if (nomeEmit != null) nova.setCampo('XNOMEEMIT', corta(nomeEmit, 60));
if (nomeDest != null) nova.setCampo('XNOMEDEST', corta(nomeDest, 60));
if (docDest  != null) {
    nova.setCampo('CNPJDEST', corta(docDest, 14));
    nova.setCampo('CNPJPARC', corta(docDest, 14));
}

// --- documento referenciado (a venda original que gerou a devolucao)
if (refNFe != null) {
    nova.setCampo('DOCSREF', '<docsRef><chaveAcesso>' + refNFe + '</chaveAcesso></docsRef>');
}

nova.save();

mensagem = "Gravado na TGFIXN!"
    + " Tipo: " + alvo.type
    + " | NF: " + serieDaChave(chaveAlvo) + "/" + numeroDaChave(chaveAlvo)
    + " | Valor: " + vNF
    + " | CFOP: " + cfop
    + " | Dest: " + nomeDest
    + " | idOrder: " + idOrder;
