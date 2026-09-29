-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `accessTokenHash` CHAR(64) NULL;

-- CreateTable
CREATE TABLE `OrgEffectivePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `content` JSON NOT NULL,
    `contentSha256` CHAR(64) NOT NULL,
    `sources` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgEffectivePolicy_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Organization_accessTokenHash_key` ON `Organization`(`accessTokenHash`);

-- AddForeignKey
ALTER TABLE `OrgEffectivePolicy` ADD CONSTRAINT `OrgEffectivePolicy_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

