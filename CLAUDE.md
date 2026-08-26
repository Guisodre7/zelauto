# ZelAuto

Backend multi-loja para revendas de veículos, construído em Supabase.

Sistema único que reúne estoque, CRM, financiamento, carnê próprio,
consignação, papelada e acompanhamento do RENAVE — para revendas de 8 a 30
carros. Substitui as três ou quatro ferramentas separadas que a loja usa hoje.

---

## Arquivos que mandam neste projeto

| Arquivo | O que é |
|---|---|
| `docs/backend.md` | **Fonte da verdade.** Schema, RLS, funções, fases, ordem de execução |
| `app/zelauto.html` | Frontend pronto e testado. 16 telas funcionando com dados em memória |

**Antes de responder qualquer coisa sobre schema, política de segurança, nome
de tabela ou ordem de execução, consulte `docs/backend.md`.**

Se algo não estiver na especificação, pergunte. Não invente coluna, tabela,
nome de função ou estrutura. Se a especificação estiver errada ou incompleta,
diga — e atualizamos o documento antes de escrever código.

O protótipo já está testado e a camada de telas **não deve ser reescrita**.
A única coisa que muda nele é a camada de dados: o objeto `DB` em memória dá
lugar a chamadas ao Supabase, uma entidade por vez.

---

## Como trabalhar comigo

- **Uma etapa por vez**, na ordem da seção 15 da especificação. Nunca entregue
  várias migrations de uma vez.
- Ao terminar uma etapa, **liste o que foi feito e pare** para eu confirmar
  antes de seguir para a próxima.
- Quando eu pedir algo grande, **mostre o plano antes de executar**. Prefiro
  corrigir um plano a corrigir dez arquivos.
- Se eu pedir algo que contraria a especificação, **aponte a contradição antes
  de executar**.
- Explique decisões técnicas em português claro. Estou aprendendo enquanto
  construo.

---

## Regras que não se quebram

**Isolamento entre lojas**
- Toda tabela de negócio tem `loja_id uuid not null`, índice em `loja_id`,
  RLS habilitada com `force row level security` e a política restritiva
  `guarda_loja`.
- **Toda tabela nova exige teste de isolamento no mesmo passo.** Tabela sem
  teste de isolamento não está pronta e não vai para produção.
- O `loja_id` vem de `app_metadata` no JWT, nunca de `user_metadata`.
- Em política, sempre `(select auth.jwt())` entre parênteses — não
  `auth.jwt()` solto.

**Schema**
- Só por migration versionada em `supabase/migrations/`.
- **Nunca** alterar schema pelo painel do Supabase.
- Migration nova nunca reescreve migration já aplicada em produção.

**Segredos**
- `service_role` só em Edge Function. Nunca em código que roda no navegador.
- Credencial de provedor fiscal e de portal de anúncio: só server-side.
- Nada de chave, token ou senha commitado no repositório.

**Comandos destrutivos**
- Antes de `drop`, `delete`, `truncate` ou `supabase db reset`: **pergunte**.
- Em produção, nunca execute nada destrutivo sem confirmação explícita minha.

---

## Onde estamos

Fase 1 — autenticação, RLS, veículos, clientes, vendas, despesas, equipe e
fotos. O objetivo é o sistema **gravando de verdade**.

Fora da fase 1: emissão real de NF-e, integrador de anúncios e assinatura
eletrônica com validade jurídica. São integrações com terceiros, cada uma com
homologação própria. **Não prometa nem construa antes da hora.**

---

## Contexto do negócio

Sou desenvolvedor e meu irmão cuida do comercial. O primeiro cliente é uma
revenda em Lauro de Freitas, na Bahia.

A promessa comercial é colocar a loja no ar em até sete dias e **devolver o
dinheiro se não servir**. Duas consequências práticas:

1. **Confiabilidade e isolamento valem mais que velocidade.** Duas lojas do
   mesmo auto shopping vão usar o sistema. Se uma enxergar o preço de compra
   da outra, o negócio acaba.
2. **O que for entregue precisa funcionar de verdade.** Um lojista que abre o
   painel e encontra tudo em branco é um cliente perdido e uma indicação
   perdida junto.

---

## Antes de dizer que uma etapa está pronta

- [ ] Tabelas novas têm `loja_id`, índice e RLS com `force row level security`
- [ ] Política restritiva `guarda_loja` criada
- [ ] Nenhuma tabela com RLS ligada e zero políticas
- [ ] Toda política de `update` tem `select` correspondente
- [ ] Testes de isolamento escritos e passando
- [ ] Nenhum `service_role` fora de Edge Function
- [ ] Avisos de segurança do Supabase revisados
- [ ] Migration aplicada em dev e testada com `supabase db reset`
