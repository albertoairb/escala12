# Escala de Oficiais — pacote mínimo (Docker)

## Rodar (recomendado)
1) Copie `.env.example` para `.env` (já existe um `.env` pronto neste pacote).
2) Suba:
   - `docker compose up -d --build`
3) Acesse:
   - http://localhost:8088
4) Saúde:
   - http://localhost:8088/api/health

## Editar lista de oficiais (sem RE)
Edite: `data/escala.json` -> campo `officers`.

## Regras
- segunda a domingo (período já preenchido: 23/02/2026 a 01/03/2026)
- qualquer pessoa pode editar
- para salvar: obrigatório preencher `quem alterou` e `motivo da alteração`
- histórico permanente (append-only)
- trava: sexta 10h até domingo (visualização liberada)

## Backup
- o "banco" é `data/escala.json`
- basta copiar esse arquivo para guardar o histórico/escala.
