-- CreateTable
CREATE TABLE "Case" (
    "id" BIGSERIAL NOT NULL,
    "debtorName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasePublicLink" (
    "id" BIGSERIAL NOT NULL,
    "caseId" BIGINT NOT NULL,
    "publicId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasePublicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseDocument" (
    "id" BIGSERIAL NOT NULL,
    "caseId" BIGINT NOT NULL,
    "docType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "CaseDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CasePublicLink_caseId_key" ON "CasePublicLink"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CasePublicLink_publicId_key" ON "CasePublicLink"("publicId");

-- CreateIndex
CREATE INDEX "CaseDocument_caseId_idx" ON "CaseDocument"("caseId");

-- AddForeignKey
ALTER TABLE "CasePublicLink" ADD CONSTRAINT "CasePublicLink_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseDocument" ADD CONSTRAINT "CaseDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
