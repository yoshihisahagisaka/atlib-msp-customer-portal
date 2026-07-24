import { Storage } from '@google-cloud/storage';

/**
 * 月次レポートPPTXの保存先(Cloud Storage)を一手に引き受けるクラス。
 * バッチ(生成側)・ポータル(ダウンロード側)の両方から使われる共有コード。
 */
export class ReportStorage {
  private readonly storage = new Storage();

  constructor(private readonly bucketName: string) {}

  private objectPath(customerCode: string, reportPeriod: string): string {
    return `${customerCode}/${reportPeriod}.pptx`;
  }

  /** base64エンコードされたPPTXデータをアップロードし、gs://パスを返す。 */
  async uploadReport(customerCode: string, reportPeriod: string, base64Data: string): Promise<string> {
    const objectPath = this.objectPath(customerCode, reportPeriod);
    const buffer = Buffer.from(base64Data, 'base64');
    await this.storage.bucket(this.bucketName).file(objectPath).save(buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    return `gs://${this.bucketName}/${objectPath}`;
  }

  /** gs://パスからPPTXの中身をバッファとして取得する(承認画面のダウンロード/メール添付用)。 */
  async downloadReport(filePath: string): Promise<Buffer> {
    const objectPath = filePath.replace(`gs://${this.bucketName}/`, '');
    const [buffer] = await this.storage.bucket(this.bucketName).file(objectPath).download();
    return buffer;
  }
}
