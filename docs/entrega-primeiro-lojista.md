# Entrega do primeiro lojista — runbook

Passo a passo para colocar uma revenda no ar. Divido em **três blocos**:
(A) preparar a plataforma **uma vez**, (B) o **dia da entrega** por loja (poucos
passos), (C) o que fica para **ligar depois** (onboarding fiscal/portais).

Meta: dia da entrega em **menos de um dia** de trabalho, quase tudo no Console do
Operador.

---

## A. Uma vez só (preparar a plataforma) — antes do primeiro cliente

Feito uma vez para todo o produto, não por loja.

- [ ] **Projeto Supabase de produção** criado (separado do dev).
- [ ] `git pull` na `main` e **aplicar todas as migrations**:
  ```
  supabase link --project-ref <ref-de-producao>
  supabase db push
  supabase migration list
  ```
  Conferir que Local = Remote até a última migration.
- [ ] **Deploy das Edge Functions** de produção:
  ```
  supabase functions deploy equipe
  supabase functions deploy custos
  supabase functions deploy vender
  supabase functions deploy exportar-dados
  supabase functions deploy marca-loja
  supabase functions deploy admin
  supabase functions deploy site-loja
  ```
- [ ] **Rodar o teste de isolamento** (`supabase/tests/isolamento_sql_editor.sql`)
  no SQL Editor de produção → tem que dar **tudo verde**. Sem isso, não entrega.
- [ ] **`app/dados.config.js`** preenchido com a URL e a anon key **de produção**
  (arquivo fora do git).
- [ ] **Você (operador)** criado na tabela `operadores` (o seu `auth.users.id`),
  para acessar o Console do Operador.
- [ ] Hospedar `app/`, `site/`, `admin/` (a raiz do repo) num host estático e
  apontar `app.zelauto.com.br` para lá.
- [ ] Revisar os avisos de segurança do Supabase (Security Advisor).

---

## B. Dia da entrega (por loja) — poucos passos

### B1. Coletar do lojista (uma vez, na conversa/WhatsApp)
- [ ] **Identidade:** razão social, CNPJ, Inscrição Estadual, endereço, telefone.
- [ ] **Marca:** logo (quadrada, PNG) e, se tiver, banner (horizontal).
- [ ] **Slug** desejado da loja (ex.: `vancar`) — vira o link e o site.
- [ ] **Estoque e clientes** do sistema atual, exportados em **CSV**.
- [ ] **(fiscal/RENAVE, se for ligar já):** certificado **e-CNPJ A1** e com qual
  integradora/provedor pretende trabalhar. **Isto você recebe e guarda você** —
  nunca entra no navegador do lojista.

### B2. Provisionar no Console do Operador (`/admin`)
- [ ] **Criar loja**: nome, slug, cor. Gera o **login do dono + senha provisória**.
      Anotar (aparece uma vez).
- [ ] **Importar estoque** (CSV de veículos) e **importar clientes** (CSV de leads).

### B3. Ajustes finais (entrando como o dono, ou orientando ele)
- [ ] Configurações › **Dados da empresa**: conferir razão social, CNPJ, endereço.
- [ ] Configurações › **Site da loja**: subir **logo** e **banner**.
- [ ] Configurações › **Central de integrações**: registrar CNPJ/IE, provedor de
      NF-e, integradora RENAVE e ids de anunciante (status fica "com o ZelAuto"
      no que depender de você).
- [ ] **Cadastrar a equipe** (vendedores) em Equipe — cada um com o acesso certo
      (vendedor não vê custo/lucro; só o proprietário exclui lead).
- [ ] Abrir o **site público** da loja (`site-loja?slug=<slug>`) e conferir que o
      estoque aparece.

### B4. Entregar
- [ ] Passar **link de acesso + senha provisória** ao dono.
- [ ] Orientar a **trocar a senha no primeiro acesso** (Configurações › Conta) —
      depois disso você não fica com o login dele.
- [ ] Explicar o que **já funciona** (bloco de "Pronto para usar" abaixo) e o que
      **entra depois** (bloco C).

---

## Checklist "pronto para usar" (testar antes de entregar)

Entra como o dono e confirma que grava de verdade (recarregar a página e o dado
continua lá):
- [ ] **Estoque:** cadastrar um carro → recarregar → continua.
- [ ] **Cliente/CRM:** cadastrar lead, registrar um contato → aparece no histórico.
- [ ] **Venda:** lançar uma venda → o carro sai do estoque, entra em Vendas.
- [ ] **Despesa:** lançar uma despesa fixa → aparece no DRE do mês.
- [ ] **Isolamento:** logar como a Loja A não mostra nada da Loja B.
- [ ] **Custo escondido:** logar como vendedor → não vê preço de compra nem lucro.
- [ ] **Carnê, contrato (PDF por impressão), consignação, RENAVE (acompanhamento),
      DRE por mês, auditoria** — abrir cada um e ver que não está quebrado.

---

## C. Fica para "ligar depois" (onboarding assistido) — deixar claro

Não bloqueia a venda da assinatura, mas **não prometa como "já ligado"**:
- [ ] **NF-e real** (transmissão à SEFAZ): depende do certificado + provedor.
      Hoje o sistema **reserva o número e registra a nota como "processando"**; a
      transmissão liga quando o provedor estiver configurado.
- [ ] **Registro no RENAVE** (entrada/saída oficial): depende de fechar com a
      **integradora**. Hoje o sistema faz o **acompanhamento**.
- [ ] **Sync dos portais** (empurrar para Webmotors/OLX): depende da credencial de
      anunciante. Hoje o **feed padrão** já existe.

**Roteiro comercial honesto:** venda o *sistema de gestão completo e isolado no ar
em 7 dias*; NF-e/RENAVE-registro/portais entram como "ativamos na implantação".

---

## Promessa comercial (lembrete)
- Loja no ar em **até 7 dias**.
- **Devolução do dinheiro se não servir.** Por isso o checklist "pronto para usar"
  acima não é opcional — o lojista não pode abrir e ver tela em branco.

---

## Apêndice — comandos rápidos
```
git pull
supabase db push
supabase migration list
supabase functions deploy <nome-da-funcao>
```
Migration nova depois de merge → sempre `git pull` (sem `origin main`) e
`supabase db push`.
