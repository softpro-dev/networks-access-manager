-- AlterTable
ALTER TABLE `Device` ADD COLUMN `macAddress` CHAR(17) NULL,
    ADD COLUMN `serialNumber` VARCHAR(100) NULL,
    MODIFY `deviceUuid` CHAR(36) NULL,
    MODIFY `hostname` VARCHAR(255) NULL,
    MODIFY `windowsVersion` VARCHAR(200) NULL,
    MODIFY `agentVersion` VARCHAR(50) NULL,
    MODIFY `interfaces` JSON NULL,
    MODIFY `status` ENUM('PRE_REGISTERED', 'PENDING', 'APPROVED', 'REJECTED', 'REVOKED') NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE `Policy` ADD COLUMN `kind` ENUM('ALLOW_ONLY', 'BLACKLIST', 'REDIRECT') NOT NULL DEFAULT 'BLACKLIST';

-- CreateTable
CREATE TABLE `DeviceEffectivePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `deviceId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `content` JSON NOT NULL,
    `contentSha256` CHAR(64) NOT NULL,
    `sources` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DeviceEffectivePolicy_deviceId_key`(`deviceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LoginLink` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LoginLink_tokenHash_key`(`tokenHash`),
    INDEX `LoginLink_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Device_organizationId_macAddress_key` ON `Device`(`organizationId`, `macAddress`);

-- AddForeignKey
ALTER TABLE `DeviceEffectivePolicy` ADD CONSTRAINT `DeviceEffectivePolicy_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `Device`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoginLink` ADD CONSTRAINT `LoginLink_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LoginLink` ADD CONSTRAINT `LoginLink_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

