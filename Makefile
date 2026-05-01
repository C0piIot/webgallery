.PHONY: install lint test test-watch e2e shell up down clean logs

install:
	docker compose run --rm tools npm install
	git config core.hooksPath .githooks

lint:
	docker compose run --rm tools npm run lint

test:
	docker compose run --rm tools npm test

test-watch:
	docker compose run --rm tools npm run test:watch

e2e:
	docker compose up -d minio minio-init
	docker compose run --rm tools npm run e2e

shell:
	docker compose run --rm tools bash

up:
	docker compose up -d static minio

down:
	docker compose down

clean:
	docker compose down -v

logs:
	docker compose logs -f
